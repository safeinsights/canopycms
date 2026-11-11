import path from 'node:path'

import type { SimpleGit } from 'simple-git'

import type { ContentFormat, FieldConfig } from '../config'
import type { FlatSchemaItem } from '../config/types'
import { entryLogicalPathOfFile } from '../content-id-index'
import { parseEntryParts } from '../content-listing'
import {
  mergeCollectionMeta,
  mergeEntry,
  type EntryMergeResult,
  type FieldConflict,
  type KeyRemap,
  type MergeSide,
} from '../merge/entry-merge'
import { exactToken } from '../merge/value-equality'
import {
  LOCATION_CONFLICT_KEY,
  type FoundEntryConflict,
  type MergeConflictField,
  type MergeSides,
} from '../merge-conflicts'
import { normalizeFilesystemPath } from '../paths/normalize'
import type { ContentId } from '../paths/types'
import { serializeFrontmatter, serializeYaml } from '../utils/content-serialize'
import { getErrorMessage } from '../utils/error'
import { escapeForLog } from '../utils/escape-text'
import { isPlainRecord } from '../validation/field-traversal'
import { serializeJson } from '../utils/json-source-splice'
import { parseTypedFilename } from '../utils/typed-filename'
import { runGit } from './git-process'
import { workerLogWarn } from './log'
import { sharedRepoProcessOptions } from './shared-repo-git'

/**
 * The worker's side of the field merge: which files of a merge the engine (`merge/entry-merge.ts`)
 * decides, and the blobs it decides them with. A merge's three versions are the merge base
 * (ancestor), the commit coming in (base) and the branch's own (branch). Every entry file and
 * `.collection.json` changed on both sides goes through the engine, whether or not git found a
 * conflict in it: a merge git calls clean can still be wrong, such as a duplicate frontmatter key.
 *
 * Entries are paired by the content ID in their file names, not by path, so a rename on one side
 * meets an edit on the other whatever git's rename detection makes of it. An entry changed on one
 * side only takes that side's version: where git's rename detection put something else there, the
 * pairing by ID puts it right.
 */

/** A file in one version of the tree. */
interface TreeFile {
  path: string
  oid: string
  mode: string
}

/** The versions of one entry, or of one `.collection.json`, across a merge. */
interface Unit {
  kind: 'entry' | 'meta'
  /** The entry's content ID; a `.collection.json` is paired by its path alone. */
  id?: ContentId
  ancestor?: TreeFile
  /** What each side changed it to: undefined for deleted. Read only for a side that changed it. */
  changed: { base?: TreeFile; branch?: TreeFile }
  touched: { base: boolean; branch: boolean }
  /** Two files of one version claim the ID, or a version is not a regular file: git's rule. */
  ambiguous: boolean
}

/** What the resolver makes of a merge, for `buildMergeCommit` to stage. */
export interface FieldMergeResult {
  /** Paths whose blob in the merge replaces git's: a file, or null for none. */
  updates: Map<string, TreeFile | null>
  /** Every path of the units the resolver decided: git's conflicts on them are settled. */
  covered: Set<string>
  conflicts: FoundEntryConflict[]
  /** Item keys the merge changed, by the logical path the branch's comment threads name. */
  keyRemaps: Array<{ entryPath: string; remaps: KeyRemap[] }>
  /** Where each entry with a conflict on record may now be: its path in the merge. */
  paths: Map<string, string>
}

export interface FieldMergeArgs {
  git: SimpleGit
  clonePath: string
  ancestor: string
  head: string
  other: string
  /** The tree git's merge wrote. */
  mergedTree: string
  /** Paths git left conflicted. */
  conflicted: ReadonlySet<string>
  contentRoot: string
  /** The branch's entry types, which name conflicts as the "Show changes" drawer does. */
  flatSchema: readonly FlatSchemaItem[] | undefined
  /** The content ID a `.collection.json` path belongs to. */
  collectionIdOf: (file: string) => ContentId | undefined
  timeoutMs: number
}

/** The size cap "Show changes" reads with: a bigger version is not merged field by field. */
const MAX_MERGE_BYTES = 1024 * 1024
const REGULAR_FILE = /^100(644|755)$/
const FORMATS: readonly ContentFormat[] = ['md', 'mdx', 'json', 'yaml']

const formatOf = (file: string): ContentFormat | undefined => {
  const ext = path.posix.extname(file)
  return FORMATS.find((f) => (f === 'yaml' ? ext === '.yaml' : ext === `.${f}`))
}

/** The unit a path belongs to, by its key, or null for a path the engine never decides. */
function unitKeyOf(file: string, root: string): { key: string; id?: ContentId } | null {
  if (entryLogicalPathOfFile(file, root) !== null) {
    const parsed = parseTypedFilename(path.posix.basename(file))
    return parsed ? { key: `id:${parsed.id}`, id: parsed.id } : null
  }
  const below = file.startsWith(`${root}/`) ? file.slice(root.length + 1).split('/') : null
  if (!below || below.at(-1) !== '.collection.json') return null
  if (below.slice(0, -1).some((s) => s.startsWith('.') || s === '_ids_')) return null
  return { key: `meta:${file}` }
}

/** `diff-tree --raw` from `from` to `to`, without rename detection: each path's two files. */
async function changedFiles(
  git: SimpleGit,
  from: string,
  to: string,
): Promise<Array<{ path: string; before?: TreeFile; after?: TreeFile }>> {
  const out = await git.raw([
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    '--raw',
    '--end-of-options',
    from,
    to,
  ])
  const fields = out.split('\0')
  const changes: Array<{ path: string; before?: TreeFile; after?: TreeFile }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[i])
    if (!match) throw new Error(`Unreadable git diff-tree entry: ${JSON.stringify(fields[i])}`)
    const [, beforeMode, afterMode, beforeOid, afterOid, status] = match
    const file = fields[i + 1]
    changes.push({
      path: file,
      ...(status !== 'A' && { before: { path: file, oid: beforeOid, mode: beforeMode } }),
      ...(status !== 'D' && { after: { path: file, oid: afterOid, mode: afterMode } }),
    })
  }
  return changes
}

/** The units both sides' changes touch, keyed as {@link unitKeyOf} keys them. */
async function collectUnits(args: FieldMergeArgs, root: string): Promise<Map<string, Unit>> {
  const { git, ancestor, head, other } = args
  const units = new Map<string, Unit>()
  for (const [side, to] of [
    ['base', other],
    ['branch', head],
  ] as const) {
    for (const change of await changedFiles(git, ancestor, to)) {
      const at = unitKeyOf(change.path, root)
      if (!at) continue
      let unit = units.get(at.key)
      if (!unit) {
        unit = {
          kind: at.id ? 'entry' : 'meta',
          ...(at.id && { id: at.id }),
          changed: {},
          touched: { base: false, branch: false },
          ambiguous: false,
        }
        units.set(at.key, unit)
      }
      const { before, after } = change
      if (before) {
        if (unit.ancestor && unit.ancestor.path !== before.path) unit.ambiguous = true
        unit.ancestor = before
      }
      if (after) {
        if (unit.changed[side]) unit.ambiguous = true
        unit.changed[side] = after
      }
      unit.touched[side] = true
      for (const file of [before, after]) {
        if (file && !REGULAR_FILE.test(file.mode)) unit.ambiguous = true
      }
    }
  }
  return units
}

/** One side's file, as it stands after that side's changes. */
const sideFile = (unit: Unit, side: 'base' | 'branch'): TreeFile | undefined =>
  unit.touched[side] ? unit.changed[side] : unit.ancestor

/** What git's merge holds for each unit: path to file. */
async function gitsFiles(
  args: FieldMergeArgs,
  root: string,
  units: ReadonlyMap<string, Unit>,
): Promise<Map<string, Map<string, TreeFile>>> {
  const held = new Map<string, Map<string, TreeFile>>()
  for (const [key, unit] of units) {
    held.set(key, new Map(unit.ancestor ? [[unit.ancestor.path, unit.ancestor]] : []))
  }
  for (const change of await changedFiles(args.git, args.ancestor, args.mergedTree)) {
    const at = unitKeyOf(change.path, root)
    const files = at && held.get(at.key)
    if (!files) continue
    if (change.before) files.delete(change.path)
    if (change.after) files.set(change.path, change.after)
  }
  return held
}

/** A blob's text, or undefined when it is too large or not UTF-8. */
async function readText(git: SimpleGit, oid: string): Promise<string | undefined> {
  const size = parseInt((await git.raw(['cat-file', '-s', '--end-of-options', oid])).trim(), 10)
  if (!Number.isInteger(size) || size > MAX_MERGE_BYTES) return undefined
  const text = await git.raw(['cat-file', 'blob', '--end-of-options', oid])
  return Buffer.byteLength(text, 'utf8') === size && !text.includes('�') ? text : undefined
}

interface ParsedSide {
  file: TreeFile
  text: string
  side: MergeSide
}

/** One version of an entry, parsed as `ContentStore.read` parses it, or undefined if it can't be. */
async function readEntry(
  git: SimpleGit,
  file: TreeFile,
  format: ContentFormat,
): Promise<ParsedSide | undefined> {
  const text = await readText(git, file.oid)
  if (text === undefined) return undefined
  try {
    const { data, body } = parseEntryParts(text, format)
    // A copy: gray-matter's cache hands every reader of the same text one object.
    const side: MergeSide = { data: structuredClone(data) }
    if (body !== undefined) side.body = body
    const type = parseTypedFilename(path.posix.basename(file.path))?.type
    if (type !== undefined) side.entryType = type
    return { file, text, side }
  } catch {
    return undefined
  }
}

/** The branch's fields for the entry type a file stores, when the schema snapshot has them. */
function fieldsFor(
  flatSchema: readonly FlatSchemaItem[] | undefined,
  file: string,
  root: string,
): readonly FieldConfig[] | undefined {
  const logical = entryLogicalPathOfFile(file, root)
  const type = parseTypedFilename(path.posix.basename(file))?.type
  if (!flatSchema || logical === null || type === undefined) return undefined
  const collection = logical.slice(0, logical.lastIndexOf('/'))
  const item = flatSchema.find(
    (i) => i.type === 'entry-type' && i.parentPath === collection && i.name === type,
  )
  return item?.type === 'entry-type' ? item.schema : undefined
}

const sameContent = (x: MergeSide, y: { data: unknown; body?: string }): boolean =>
  exactToken(x.data) === exactToken(y.data) && x.body === y.body

/** Text for merged entry data, written onto `onto` (the base's file) to keep its formatting. */
function serializeEntry(
  format: ContentFormat,
  merged: { data: Record<string, unknown>; body?: string },
  onto: string | undefined,
): string {
  if (format === 'json') return serializeJson(merged.data, onto)
  if (format === 'yaml') return serializeYaml(merged.data, onto)
  return serializeFrontmatter(merged.body ?? '', merged.data, onto, format)
}

const blobSides = (unit: Unit): MergeSides => {
  const [ancestor, base, branch] = [unit.ancestor, sideFile(unit, 'base'), sideFile(unit, 'branch')]
  return {
    ...(ancestor && { ancestor: ancestor.oid }),
    ...(base && { base: base.oid }),
    ...(branch && { branch: branch.oid }),
  }
}

const recordFields = (conflicts: readonly FieldConflict[]): FoundEntryConflict['fields'] =>
  conflicts.map(
    ({
      key,
      dataPath,
      kind,
      item,
      regions,
      unparseable,
    }): Omit<MergeConflictField, 'mergeSha' | 'sides'> => ({
      key,
      dataPath,
      kind,
      ...(item && { item }),
      ...((regions !== undefined || unparseable) && { text: true as const }),
    }),
  )

/** What one unit resolves to: its file in the merge, and what a person must still decide. */
interface Resolution {
  file?: TreeFile
  conflict?: Omit<FoundEntryConflict, 'contentId'>
  remaps?: KeyRemap[]
}

class Resolver {
  private readonly root: string
  private readonly options: ReturnType<typeof sharedRepoProcessOptions> & {
    inactivityTimeoutMs: number
  }

  constructor(private readonly args: FieldMergeArgs) {
    this.root = normalizeFilesystemPath(args.contentRoot)
    this.options = {
      ...sharedRepoProcessOptions(args.clonePath, 'worktree'),
      inactivityTimeoutMs: args.timeoutMs,
    }
  }

  async write(text: string, like: TreeFile, at: string): Promise<TreeFile> {
    // `--no-filters`: no clean filter from the clone's attributes runs.
    const oid = (
      await runGit(['hash-object', '-w', '--no-filters', '--stdin'], {
        ...this.options,
        stdin: text,
      })
    ).trim()
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) throw new Error('git hash-object printed no id')
    return { path: at, oid, mode: like.mode }
  }

  /**
   * An entry both sides changed. The file stays where the branch has it unless only the base moved
   * it; both moving it apart is a location conflict. A version that can't be merged field by field
   * leaves git's merge where git merged it, and the branch's file where git could not.
   */
  async entry(
    unit: Unit,
    gitClean: boolean,
    gitFile: TreeFile | undefined,
  ): Promise<Resolution | null> {
    const { git } = this.args
    const [o, a, b] = [unit.ancestor, sideFile(unit, 'base'), sideFile(unit, 'branch')]
    const sides = blobSides(unit)
    if (!a && !b) return {}
    if (!a && b) return { file: b, conflict: { path: b.path, kind: 'deleted-on-base', sides } }
    if (a && !b) {
      return { conflict: { path: o?.path ?? a.path, kind: 'deleted-on-branch', sides } }
    }
    if (!a || !b) return null
    if (a.oid === b.oid && a.path === b.path) return { file: b }
    const unreadable = (): Resolution | null =>
      gitClean ? null : { file: b, conflict: { path: b.path, kind: 'unreadable', sides } }

    const format = formatOf(b.path)
    if (!format || [o, a].some((f) => f && formatOf(f.path) !== format)) return unreadable()
    const [oSide, aSide, bSide] = await Promise.all(
      [o, a, b].map((f) => (f ? readEntry(git, f, format) : undefined)),
    )
    if (!aSide || !bSide || (o && !oSide)) return unreadable()

    const moved = { base: a.path !== (o?.path ?? a.path), branch: b.path !== (o?.path ?? b.path) }
    const at = moved.base && !moved.branch ? a.path : b.path
    const locationConflict = a.path !== b.path && (o === undefined || (moved.base && moved.branch))
    const fields = fieldsFor(this.args.flatSchema, b.path, this.root)

    let result: EntryMergeResult
    try {
      result = mergeEntry({
        format,
        ancestor: oSide?.side ?? { data: {} },
        base: aSide.side,
        branch: bSide.side,
        ...(fields && { fields }),
      })
    } catch (err) {
      workerLogWarn(
        `  could not merge ${escapeForLog(b.path)} field by field: ${getErrorMessage(err)}`,
      )
      return { file: b, conflict: { path: b.path, kind: 'unreadable', sides } }
    }
    if (result.kind === 'entry-conflict') {
      return { file: b, conflict: { path: b.path, kind: 'unreadable', sides } }
    }

    const found = recordFields(result.conflicts) ?? []
    if (locationConflict) {
      found.push({ key: LOCATION_CONFLICT_KEY, dataPath: [], kind: 'changed' })
    }
    const resolution: Resolution = {
      ...(found.length > 0 && { conflict: { path: at, kind: 'fields', sides, fields: found } }),
      ...(result.keyRemaps.length > 0 && { remaps: result.keyRemaps }),
    }
    // The fewest changed bytes: a side's own file, git's merge, then the merge written onto the
    // base's file, which keeps a developer's comments and formatting there.
    if (sameContent(bSide.side, result)) return { ...resolution, file: { ...b, path: at } }
    if (sameContent(aSide.side, result))
      return { ...resolution, file: { ...a, path: at, mode: b.mode } }
    if (gitClean && gitFile?.path === at) {
      const gitSide = await readEntry(git, gitFile, format)
      if (gitSide && sameContent(gitSide.side, result)) return { ...resolution, file: gitFile }
    }
    for (const onto of [aSide.text, undefined]) {
      const text = serializeEntry(format, result, onto)
      const reads = (() => {
        try {
          const back = parseEntryParts(text, format)
          return sameContent(
            { data: back.data, ...(back.body !== undefined && { body: back.body }) },
            result,
          )
        } catch {
          return false
        }
      })()
      if (reads) return { ...resolution, file: await this.write(text, b, at) }
    }
    workerLogWarn(`  the merge of ${escapeForLog(b.path)} does not read back as merged`)
    return { file: b, conflict: { path: b.path, kind: 'unreadable', sides } }
  }

  /** A `.collection.json` both sides changed and both still have; else git's rule. */
  async collectionMeta(unit: Unit): Promise<Resolution | null> {
    const { git } = this.args
    const [o, a, b] = [unit.ancestor, sideFile(unit, 'base'), sideFile(unit, 'branch')]
    if (!o || !a || !b) return null
    const parse = async (file: TreeFile) => {
      const text = await readText(git, file.oid)
      if (text === undefined) return undefined
      try {
        const json: unknown = JSON.parse(text)
        return isPlainRecord(json) ? { text, json } : undefined
      } catch {
        return undefined
      }
    }
    const [oJson, aJson, bJson] = await Promise.all([o, a, b].map(parse))
    if (!oJson || !aJson || !bJson) return null
    const merged = mergeCollectionMeta(oJson.json, aJson.json, bJson.json)
    const contentId = this.args.collectionIdOf(b.path)
    const fields = recordFields(merged.conflicts) ?? []
    const resolution: Resolution = {
      ...(fields.length > 0 &&
        contentId && {
          conflict: { path: b.path, kind: 'fields', sides: blobSides(unit), fields },
        }),
    }
    if (fields.length > 0 && !contentId) {
      workerLogWarn(`  ${escapeForLog(b.path)} keeps this branch's values where both changed them`)
    }
    const token = exactToken(merged.data)
    if (exactToken(bJson.json) === token) return { ...resolution, file: b }
    if (exactToken(aJson.json) === token)
      return { ...resolution, file: { ...a, path: b.path, mode: b.mode } }
    for (const onto of [aJson.text, undefined]) {
      const text = serializeJson(merged.data, onto)
      try {
        if (exactToken(JSON.parse(text)) === token) {
          return { ...resolution, file: await this.write(text, b, b.path) }
        }
      } catch {
        // Tried again without the base's formatting.
      }
    }
    return null
  }
}

/** Two sets of a unit's files hold the same thing. */
function sameFiles(held: ReadonlyMap<string, TreeFile>, wanted: TreeFile | undefined): boolean {
  if (!wanted) return held.size === 0
  const at = held.get(wanted.path)
  return held.size === 1 && at?.oid === wanted.oid && at.mode === wanted.mode
}

/**
 * Decide every entry file and `.collection.json` the merge touches. Nothing is staged here: the
 * result says which blobs replace git's, and which conflicts a person must resolve.
 */
export async function resolveFieldMerge(args: FieldMergeArgs): Promise<FieldMergeResult> {
  const resolver = new Resolver(args)
  const root = normalizeFilesystemPath(args.contentRoot)
  const units = await collectUnits(args, root)
  const held = await gitsFiles(args, root, units)
  const result: FieldMergeResult = {
    updates: new Map(),
    covered: new Set(),
    conflicts: [],
    keyRemaps: [],
    paths: new Map(),
  }

  for (const [key, unit] of units) {
    if (unit.ambiguous) continue
    const gitHeld = held.get(key) ?? new Map<string, TreeFile>()
    const paths = new Set([
      ...[unit.ancestor, sideFile(unit, 'base'), sideFile(unit, 'branch')].flatMap((f) =>
        f ? [f.path] : [],
      ),
      ...gitHeld.keys(),
    ])
    const gitClean = ![...paths].some((p) => args.conflicted.has(p))

    let resolution: Resolution | null
    if (unit.touched.base && unit.touched.branch) {
      const only = gitHeld.size === 1 ? [...gitHeld.values()][0] : undefined
      resolution =
        unit.kind === 'entry'
          ? await resolver.entry(unit, gitClean, only)
          : await resolver.collectionMeta(unit)
      if (resolution === null) continue
    } else {
      const side = unit.touched.base ? 'base' : 'branch'
      const file = sideFile(unit, side)
      // Git's directory rename detection moved a file one side added: that is where it belongs.
      const only = gitHeld.size === 1 ? [...gitHeld.values()][0] : undefined
      const relocated = gitClean && file && only?.oid === file.oid && only.mode === file.mode
      resolution = { file: relocated ? only : file }
    }

    for (const p of paths) result.covered.add(p)
    if (!sameFiles(gitHeld, resolution.file)) {
      for (const p of gitHeld.keys()) result.updates.set(p, null)
      for (const p of paths) {
        if (args.conflicted.has(p)) result.updates.set(p, null)
      }
      if (resolution.file) result.updates.set(resolution.file.path, resolution.file)
    }
    if (unit.id && resolution.file) result.paths.set(unit.id, resolution.file.path)
    if (unit.id && resolution.conflict) {
      result.conflicts.push({ contentId: unit.id, ...resolution.conflict })
    } else if (unit.kind === 'meta' && resolution.conflict) {
      const contentId = args.collectionIdOf(resolution.conflict.path)
      if (contentId) result.conflicts.push({ contentId, ...resolution.conflict })
    }
    const branchFile = sideFile(unit, 'branch')
    const entryPath = branchFile && entryLogicalPathOfFile(branchFile.path, root)
    if (resolution.remaps && entryPath) {
      result.keyRemaps.push({ entryPath, remaps: resolution.remaps })
    }
  }
  return result
}
