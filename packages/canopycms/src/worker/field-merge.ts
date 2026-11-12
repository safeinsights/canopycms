import path from 'node:path'

import type { SimpleGit } from 'simple-git'
import { parse as yamlParse } from 'yaml'

import type { ContentFormat, FieldConfig } from '../config'
import type { FlatSchemaItem } from '../config/types'
import { entryLogicalPathOfFile, extractIdFromFilename } from '../content-id-index'
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
 * Entries are paired by the content ID in their file names, and `.collection.json` files by their
 * collection's, not by path, so a rename on one side meets an edit on the other whatever git's
 * rename detection makes of it. A collection directory one side moved moves the other side's files
 * in it too. An entry changed on one side only takes that side's version: where git's rename
 * detection put something else there, the pairing by ID puts it right.
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
  /** The entry's content ID. A `.collection.json` is paired by its collection's, kept apart. */
  id?: ContentId
  ancestor?: TreeFile
  /** What each side changed it to: undefined for deleted. Read only for a side that changed it. */
  changed: { base?: TreeFile; branch?: TreeFile }
  touched: { base: boolean; branch: boolean }
  /** Paths each side deleted. */
  removed: { base: Set<string>; branch: Set<string> }
  /**
   * Git's rule decides it: two files of one version claim it, a side added a second file for it
   * and kept the first, a version is not a regular file, or its name is not UTF-8.
   */
  ambiguous: boolean
}

/** What the resolver makes of a merge, for `planMerge` to stage. */
export interface FieldMergeResult {
  /** Paths whose blob in the merge replaces git's: a file, or null for none. */
  updates: Map<string, TreeFile | null>
  /** Every path of the units the resolver decided: git's conflicts on them are settled. */
  covered: Set<string>
  conflicts: FoundEntryConflict[]
  /** Item keys the merge changed, by the logical path the branch's comment threads name. */
  keyRemaps: Array<{ entryPath: string; remaps: KeyRemap[] }>
  /** Where each entry or collection with a conflict on record may now be: its path in the merge. */
  paths: Map<string, string>
  /** Why git's merge can't be settled by rule, where it can't. */
  unsettled?: string
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
type Side = 'base' | 'branch'

const formatOf = (file: string): ContentFormat | undefined => {
  const ext = path.posix.extname(file)
  return FORMATS.find((f) => (f === 'yaml' ? ext === '.yaml' : ext === `.${f}`))
}

/** The unit a path belongs to, by its key, or null for a path the engine never decides. */
function unitKeyOf(
  file: string,
  root: string,
  collectionIdOf: FieldMergeArgs['collectionIdOf'],
): { key: string; id?: ContentId } | null {
  if (entryLogicalPathOfFile(file, root) !== null) {
    const parsed = parseTypedFilename(path.posix.basename(file))
    return parsed ? { key: `id:${parsed.id}`, id: parsed.id } : null
  }
  const below = file.startsWith(`${root}/`) ? file.slice(root.length + 1).split('/') : null
  if (!below || below.at(-1) !== '.collection.json') return null
  if (below.slice(0, -1).some((s) => s.startsWith('.') || s === '_ids_')) return null
  const collection = collectionIdOf(file)
  return { key: collection ? `meta:${collection}` : `meta-at:${file}` }
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

/** Where one version holds a collection directory: what it sits in, and its own name. */
interface DirAt {
  /** The collection it sits in, as `id:<ContentId>`, or the plain path of a directory with none. */
  parent: string
  name: string
}

/**
 * Where each collection directory a merge touches ends up, by its collection ID. A directory's
 * parent and its own name are settled apart, each as a field is: the branch's change, else the
 * base's. So a parent one side renamed and a child the other side renamed both come through, and
 * only both sides changing the same one differently is a move apart. A directory one version
 * holds at two places is left where each file has it.
 */
class CollectionMoves {
  private readonly at = {
    ancestor: new Map<string, DirAt | null>(),
    base: new Map<string, DirAt | null>(),
    branch: new Map<string, DirAt | null>(),
  }

  note(version: 'ancestor' | Side, file: string): void {
    const segments = file.split('/')
    let parent = ''
    for (let k = 0; k < segments.length - 1; k++) {
      const id = extractIdFromFilename(segments[k])
      if (!id) {
        parent = parent.startsWith('id:')
          ? `${parent}/${segments[k]}`
          : segments.slice(0, k + 1).join('/')
        continue
      }
      const here: DirAt = { parent, name: segments[k] }
      const known = this.at[version].get(id)
      const same = known && known.parent === here.parent && known.name === here.name
      this.at[version].set(id, known === undefined || same ? here : null)
      parent = `id:${id}`
    }
  }

  /** Each side's place for `id`'s directory, when every version that has one has just one. */
  private versions(id: string): { o?: DirAt; a?: DirAt; b?: DirAt } | undefined {
    const [o, a, b] = (['ancestor', 'base', 'branch'] as const).map((v) => this.at[v].get(id))
    if (o === null || a === null || b === null) return undefined
    return { o, a, b }
  }

  private settle(id: string): DirAt | undefined {
    const v = this.versions(id)
    if (!v) return undefined
    const pick = (part: keyof DirAt) => {
      const [o, a, b] = [v.o?.[part], v.a?.[part], v.b?.[part]]
      if (b !== undefined && b !== o) return b
      if (a !== undefined && a !== o) return a
      return o ?? b ?? a
    }
    const [parent, name] = [pick('parent'), pick('name')]
    return parent !== undefined && name !== undefined ? { parent, name } : undefined
  }

  /** Collection directories each side moved into the other: no tree holds both moves. */
  cyclic = false

  /** The path `id`'s directory ends up at, or undefined where that can't be told. */
  private final(id: string, seen: ReadonlySet<string> = new Set()): string | undefined {
    if (seen.has(id)) {
      this.cyclic = true
      return undefined
    }
    const dir = this.settle(id)
    if (!dir) return undefined
    if (!dir.parent.startsWith('id:')) return dir.parent ? `${dir.parent}/${dir.name}` : dir.name
    const [parentId, ...below] = dir.parent.slice(3).split('/')
    const parent = this.final(parentId, new Set([...seen, id]))
    return parent === undefined ? undefined : [parent, ...below, dir.name].join('/')
  }

  /** Whether both sides moved `id`'s directory, changing its parent or its name differently. */
  movedApart(id: string): boolean {
    const v = this.versions(id)
    if (!v?.o || !v.a || !v.b) return false
    const { o, a, b } = v
    return (['parent', 'name'] as const).some(
      (part) => a[part] !== o[part] && b[part] !== o[part] && a[part] !== b[part],
    )
  }

  /** `file` in the collection directories it is in, each where it ends up. */
  place(file: string): string {
    const segments = file.split('/')
    for (let k = segments.length - 2; k >= 0; k--) {
      const id = extractIdFromFilename(segments[k])
      const dir = id ? this.final(id) : undefined
      if (dir) return [dir, ...segments.slice(k + 1)].join('/')
    }
    return file
  }
}

/** The units both sides' changes touch, keyed as {@link unitKeyOf} keys them. */
async function collectUnits(
  args: FieldMergeArgs,
  root: string,
  moves: CollectionMoves,
): Promise<Map<string, Unit>> {
  const { git, ancestor, head, other } = args
  const units = new Map<string, Unit>()
  for (const [side, to] of [
    ['base', other],
    ['branch', head],
  ] as const) {
    for (const change of await changedFiles(git, ancestor, to)) {
      const { before, after } = change
      if (before) moves.note('ancestor', change.path)
      if (after) moves.note(side, change.path)
      const at = unitKeyOf(change.path, root, args.collectionIdOf)
      if (!at) continue
      let unit = units.get(at.key)
      if (!unit) {
        unit = {
          kind: at.key.startsWith('id:') ? 'entry' : 'meta',
          ...(at.id && { id: at.id }),
          changed: {},
          touched: { base: false, branch: false },
          removed: { base: new Set(), branch: new Set() },
          ambiguous: false,
        }
        units.set(at.key, unit)
      }
      if (before) {
        if (unit.ancestor && unit.ancestor.path !== before.path) unit.ambiguous = true
        unit.ancestor = before
        if (!after) unit.removed[side].add(change.path)
      }
      if (after) {
        if (unit.changed[side]) unit.ambiguous = true
        unit.changed[side] = after
      }
      unit.touched[side] = true
      for (const file of [before, after]) {
        if (file && !REGULAR_FILE.test(file.mode)) unit.ambiguous = true
      }
      if (change.path.includes('\uFFFD')) unit.ambiguous = true
    }
  }
  // A side with a file for the unit at a new path, which kept the ancestor's, copied it.
  for (const unit of units.values()) {
    for (const side of ['base', 'branch'] as const) {
      const file = unit.changed[side]
      const kept = unit.ancestor && !unit.removed[side].has(unit.ancestor.path)
      if (file && unit.ancestor && file.path !== unit.ancestor.path && kept) unit.ambiguous = true
    }
  }
  return units
}

/** One side's file, as it stands after that side's changes. */
const sideFile = (unit: Unit, side: Side): TreeFile | undefined =>
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
    const at = unitKeyOf(change.path, root, args.collectionIdOf)
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
  return Buffer.byteLength(text, 'utf8') === size && !text.includes('\uFFFD') ? text : undefined
}

interface ParsedSide {
  file: TreeFile
  text: string
  side: MergeSide
}

/**
 * Whether `text` holds a record at its top level, as an entry's data must: the store reads any
 * other JSON or YAML as no data at all, which would make every version alike.
 */
function holdsRecord(text: string, format: ContentFormat): boolean {
  if (format === 'json') return isPlainRecord(JSON.parse(text))
  if (format !== 'yaml') return true
  const value: unknown = yamlParse(text)
  return value === null || value === undefined || isPlainRecord(value)
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
    if (!holdsRecord(text, format)) return undefined
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

type FoundField = Omit<MergeConflictField, 'mergeSha' | 'sides'>

const recordFields = (conflicts: readonly FieldConflict[]): FoundField[] =>
  conflicts.map(
    ({ key, dataPath, sidePaths, kind, item, regions, unparseable }): FoundField => ({
      key,
      dataPath,
      sidePaths,
      kind,
      ...(item && { item }),
      ...((regions !== undefined || unparseable) && { text: true as const }),
    }),
  )

/** The entry's place, which no version holds a value for. */
const LOCATION: FoundField = {
  key: LOCATION_CONFLICT_KEY,
  dataPath: [],
  sidePaths: {},
  kind: 'changed',
}

/** What one unit resolves to: its file in the merge, and what a person must still decide. */
interface Resolution {
  file?: TreeFile
  conflict?: Omit<FoundEntryConflict, 'contentId'>
  remaps?: KeyRemap[]
}

/** A merged value's candidate files, in the order {@link Resolver.bytesFor} tries them. */
interface Candidates {
  /** Git's clean merge at the place the merge puts the file. */
  git?: TreeFile
  base: { file: TreeFile; text: string }
  branch: TreeFile
  /** Whether a file's text reads as the merged value. */
  reads: (text: string) => boolean
  /** Whether a side's own version is the merged value. */
  isBase: boolean
  isBranch: boolean
  serialize: (onto: string | undefined) => string
}

class Resolver {
  private readonly root: string
  private readonly options: ReturnType<typeof sharedRepoProcessOptions> & {
    inactivityTimeoutMs: number
  }

  constructor(
    private readonly args: FieldMergeArgs,
    private readonly moves: CollectionMoves,
  ) {
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
   * The file for a merged value at `at`, keeping the most of what each side wrote that the value
   * does not carry, such as a developer's comments and formatting: git's clean merge, else the
   * base's file, else the value written onto the base's file, else the branch's file, else the
   * value written plain. A text must read back as the value. Undefined when none does.
   */
  async bytesFor(c: Candidates, at: string): Promise<TreeFile | undefined> {
    const mode = c.branch.mode
    if (c.git?.path === at) {
      const text = await readText(this.args.git, c.git.oid)
      if (text !== undefined && c.reads(text)) return c.git
    }
    if (c.isBase) return { ...c.base.file, path: at, mode }
    const serialized = c.serialize(c.base.text)
    // The serializer writes some lines with `\n` alone: a base written with `\r\n` keeps them.
    const crlf = /\r\n/.test(c.base.text) && !/(^|[^\r])\n/.test(c.base.text)
    for (const onBase of crlf ? [serialized.replace(/\r?\n/g, '\r\n'), serialized] : [serialized]) {
      if (c.reads(onBase)) return this.write(onBase, c.branch, at)
    }
    if (c.isBranch) return { ...c.branch, path: at }
    const plain = c.serialize(undefined)
    return c.reads(plain) ? this.write(plain, c.branch, at) : undefined
  }

  /**
   * Where both sides' versions of a unit go: each side's path with every collection directory
   * either side moved moved too. Where only one side moved the file, there; else the branch's
   * place. Both moving it apart, or both adding it apart, is a location conflict.
   */
  placeOf(o: TreeFile | undefined, a: TreeFile, b: TreeFile): { at: string; apart: boolean } {
    const [oAt, aAt, bAt] = [
      o && this.moves.place(o.path),
      this.moves.place(a.path),
      this.moves.place(b.path),
    ]
    const moved = {
      base: oAt !== undefined && aAt !== oAt,
      branch: oAt !== undefined && bAt !== oAt,
    }
    return {
      at: moved.base && !moved.branch ? aAt : bAt,
      apart: aAt !== bAt && (oAt === undefined || (moved.base && moved.branch)),
    }
  }

  /**
   * An entry both sides changed. A version that can't be read or doesn't match the others' format
   * leaves git's merge where git merged it, and the branch's file where git could not. An entry
   * type changed on one side, a merge that throws, or merged text that doesn't read back keeps the
   * branch's file, an entry-level conflict, whatever git made of it.
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
    if (!a && b) {
      const at = this.moves.place(b.path)
      return { file: { ...b, path: at }, conflict: { path: at, kind: 'deleted-on-base', sides } }
    }
    if (a && !b) {
      return { conflict: { path: this.moves.place(a.path), kind: 'deleted-on-branch', sides } }
    }
    if (!a || !b) return null
    const { at, apart } = this.placeOf(o, a, b)
    // The branch's whole file is the branch's version of the entry, so it keeps the branch's name.
    const keepBranch = (): Resolution => {
      const own = this.moves.place(b.path)
      return { file: { ...b, path: own }, conflict: { path: own, kind: 'unreadable', sides } }
    }
    if (a.oid === b.oid && !apart) return { file: { ...b, path: at } }

    const format = formatOf(b.path)
    if (!format || [o, a].some((f) => f && formatOf(f.path) !== format)) {
      return gitClean ? null : keepBranch()
    }
    const [oSide, aSide, bSide] = await Promise.all(
      [o, a, b].map((f) => (f ? readEntry(git, f, format) : undefined)),
    )
    if (!aSide || !bSide || (o && !oSide)) return gitClean ? null : keepBranch()

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
      return keepBranch()
    }
    if (result.kind === 'entry-conflict') return keepBranch()

    const found = [...recordFields(result.conflicts), ...(apart ? [LOCATION] : [])]
    const merged = result
    const file = await this.bytesFor(
      {
        ...(gitClean && gitFile && { git: gitFile }),
        base: { file: a, text: aSide.text },
        branch: b,
        isBase: sameContent(aSide.side, merged),
        isBranch: sameContent(bSide.side, merged),
        reads: (text) => {
          try {
            if (!holdsRecord(text, format)) return false
            const back = parseEntryParts(text, format)
            return sameContent(
              { data: back.data, ...(back.body !== undefined && { body: back.body }) },
              merged,
            )
          } catch {
            return false
          }
        },
        serialize: (onto) => serializeEntry(format, merged, onto),
      },
      at,
    )
    if (!file) {
      workerLogWarn(`  the merge of ${escapeForLog(b.path)} does not read back as merged`)
      return keepBranch()
    }
    return {
      file,
      ...(found.length > 0 && { conflict: { path: at, kind: 'fields', sides, fields: found } }),
      ...(merged.keyRemaps.length > 0 && { remaps: merged.keyRemaps }),
    }
  }

  /** A `.collection.json` both sides changed and both still have; else git's rule. */
  async collectionMeta(
    unit: Unit,
    gitClean: boolean,
    gitFile: TreeFile | undefined,
  ): Promise<Resolution | null> {
    const { git } = this.args
    const [o, a, b] = [unit.ancestor, sideFile(unit, 'base'), sideFile(unit, 'branch')]
    const sides = blobSides(unit)
    // Deleted on one side and changed on the other, as for an entry: the branch's side stands.
    if (o && (!a || !b)) {
      if (!a && !b) return {}
      const contentId = this.args.collectionIdOf((b ?? a ?? o).path)
      if (!contentId) return null
      if (b) {
        const at = this.moves.place(b.path)
        return { file: { ...b, path: at }, conflict: { path: at, kind: 'deleted-on-base', sides } }
      }
      return {
        conflict: { path: this.moves.place((a ?? o).path), kind: 'deleted-on-branch', sides },
      }
    }
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
    // The directory moved apart on both sides: it goes where the branch put it.
    const dirId = extractIdFromFilename(path.posix.basename(path.posix.dirname(b.path)))
    const apart = dirId !== null && this.moves.movedApart(dirId)
    const at = this.moves.place(b.path)
    const fields = [...recordFields(merged.conflicts), ...(apart ? [LOCATION] : [])]
    const contentId = this.args.collectionIdOf(at)
    if (fields.length > 0 && !contentId) {
      workerLogWarn(`  ${escapeForLog(at)} keeps this branch's values where both changed them`)
    }
    const token = exactToken(merged.data)
    const file = await this.bytesFor(
      {
        ...(gitClean && gitFile && { git: gitFile }),
        base: { file: a, text: aJson.text },
        branch: b,
        isBase: exactToken(aJson.json) === token,
        isBranch: exactToken(bJson.json) === token,
        reads: (text) => {
          try {
            return exactToken(JSON.parse(text)) === token
          } catch {
            return false
          }
        },
        serialize: (onto) => serializeJson(merged.data, onto),
      },
      at,
    )
    if (!file) return null
    return {
      file,
      ...(fields.length > 0 &&
        contentId && { conflict: { path: at, kind: 'fields', sides, fields } }),
    }
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
  const moves = new CollectionMoves()
  const resolver = new Resolver(args, moves)
  const root = normalizeFilesystemPath(args.contentRoot)
  const units = await collectUnits(args, root, moves)
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
    const only = gitHeld.size === 1 ? [...gitHeld.values()][0] : undefined

    let resolution: Resolution | null
    if (unit.touched.base && unit.touched.branch) {
      resolution =
        unit.kind === 'entry'
          ? await resolver.entry(unit, gitClean, only)
          : await resolver.collectionMeta(unit, gitClean, only)
      if (resolution === null) continue
    } else {
      const file = sideFile(unit, unit.touched.base ? 'base' : 'branch')
      // The one side's file, where git put it if git kept it whole, else where the collection
      // directories it is in ended up.
      const kept = file && only?.oid === file.oid && only.mode === file.mode
      const from = kept ? only : file
      resolution = { file: from && { ...from, path: moves.place(from.path) } }
    }

    for (const p of paths) result.covered.add(p)
    if (!sameFiles(gitHeld, resolution.file)) {
      for (const p of gitHeld.keys()) result.updates.set(p, null)
      for (const p of paths) {
        if (args.conflicted.has(p)) result.updates.set(p, null)
      }
      if (resolution.file) result.updates.set(resolution.file.path, resolution.file)
    }
    const recordId = unit.id ?? (resolution.file && args.collectionIdOf(resolution.file.path))
    if (recordId && resolution.file) result.paths.set(recordId, resolution.file.path)
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
  if (moves.cyclic) result.unsettled = 'collection directories moved into each other'
  return result
}
