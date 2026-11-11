/**
 * CLI command: npx canopycms backfill-item-keys [--check] [--force] [--app-dir <dir>]
 *
 * Writes the `_key` of every object-list item and block (`item-keys.ts`) into the site's content,
 * so an editor's first save of an entry adds no key lines and a merge sees only real edits.
 *
 * Each entry goes through the editor's own save path, with nothing re-derived:
 * `ContentStore.read` keys the items exactly as the editor's form holds them, and
 * `ContentStore.write` writes that data back with the read's version, through the serialiser,
 * content-write lock and version check a save uses. So a written file is byte for byte what an
 * editor save of the unedited entry leaves, a second run finds every item keyed and writes
 * nothing, and the next editor save adds no lines of its own.
 *
 * A file is written only when its items lack keys. The write then also carries whatever else an
 * unedited save normalises (calendar days, the serialiser's own spellings), and those files are
 * listed apart for review. Out of scope, as for the editor: list fields the schema does not
 * describe, `.collection.json`, and entries of a type this code's registry lacks.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { diffArrays } from 'diff'
import { simpleGit } from 'simple-git'

import type { FieldConfig, FlatSchemaItem } from '../config'
import { flattenSchema } from '../config'
import { contentIndexGenerationPath } from '../content-index-generation'
import {
  listCollectionEntries,
  parseEntryParts,
  type CollectionSchemaItem,
} from '../content-listing'
import { ContentStore, type ContentDocument } from '../content-store'
import { ITEM_KEY, withItemKeys } from '../item-keys'
import { isValidSchema, resolveSchema } from '../schema'
import type { EntrySchemaRegistry } from '../schema/types'
import { serializeEntry, type SerializableEntry } from '../utils/content-serialize'
import { getErrorMessage, isNodeError } from '../utils/error'
import { filePathExists } from '../utils/fs'
import { CANOPY_META_DIR } from '../utils/git'
import { isPlainRecord } from '../validation/field-traversal'
import { importSiteEntrySchemaRegistry, importSiteServerConfig } from './site-config'

/** One entry file the backfill keys. */
interface BackfillFileResult {
  /** Path relative to the project root. */
  path: string
  /** Items and blocks whose file text gives them no usable key, or one an earlier item holds. */
  itemsKeyed: number
  /** Lines the write changes besides adding `_key` lines: what else an unedited save normalises. */
  otherLines: number
}

interface BackfillResult {
  /** Files written, or with `check`, files a run would write; by path. */
  changed: BackfillFileResult[]
  /** Entries that could not be read or written. */
  failed: { path: string; error: string }[]
  /** Entries left alone because the registry has no schema for their entry type. */
  unavailable: string[]
  /** Files in a collection that look like entries but whose names don't parse as one. */
  malformed: string[]
}

interface BackfillOptions {
  /** The project root: the directory holding the content root. */
  root: string
  flatSchema: FlatSchemaItem[]
  contentRootName: string
  /** Report what a run would write, and write nothing. */
  check: boolean
}

/**
 * Keys every entry's items under `root`, or with `check`, reports which files a run would write.
 * @internal Exported for tests.
 */
export async function backfillItemKeys(options: BackfillOptions): Promise<BackfillResult> {
  const { root, flatSchema, contentRootName, check } = options
  const store = new ContentStore(root, flatSchema, { contentRootName })
  const result: BackfillResult = { changed: [], failed: [], unavailable: [], malformed: [] }

  const collections = flatSchema.filter(
    (item): item is CollectionSchemaItem => item.type === 'collection' && !!item.entries,
  )
  for (const collection of collections) {
    const entryTypes = collection.entries ?? []
    const listed = await listCollectionEntries(root, collection, (file) =>
      result.malformed.push(path.posix.join(file.collectionPath, file.filename)),
    )
    for (const item of listed) {
      const entryType = entryTypes.find((type) => type.name === item.entryType)
      if (!entryType || entryType.unavailable) {
        result.unavailable.push(item.physicalPath)
        continue
      }
      try {
        const changed = await backfillEntry(store, item, entryType.schema, check)
        if (changed) result.changed.push({ path: item.physicalPath, ...changed })
      } catch (err) {
        result.failed.push({ path: item.physicalPath, error: getErrorMessage(err) })
      }
    }
  }

  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)
  result.changed.sort(byPath)
  result.failed.sort(byPath)
  result.unavailable.sort()
  result.malformed.sort()
  return result
}

/** The entry's counts when its items lack keys, after writing it unless `check`; else null. */
async function backfillEntry(
  store: ContentStore,
  item: Awaited<ReturnType<typeof listCollectionEntries>>[number],
  fields: readonly FieldConfig[],
  check: boolean,
): Promise<Omit<BackfillFileResult, 'path'> | null> {
  const doc = await store.read(item.collectionPath, item.slug, { resolveReferences: false })
  // After the read: its version was taken before its own read of the file, so a change landing
  // between the two fails the write's version check rather than writing over it.
  const before = await fs.readFile(doc.absolutePath, 'utf8')
  const asWritten = parseEntryParts(before, doc.format).data
  const keyed = withItemKeys(fields, asWritten, 'content')
  if (keyed === asWritten) return null

  const entry = savedEntry(doc)
  let after: string
  if (check) {
    after = serializeEntry(entry, before, fields)
  } else {
    if (doc.version === undefined) throw new Error('The read carried no version to write against.')
    await store.write(
      item.collectionPath,
      item.slug,
      { ...entry, expectedVersion: doc.version },
      item.entryType,
    )
    after = await fs.readFile(doc.absolutePath, 'utf8')
  }
  return {
    itemsKeyed: countAddedKeys(keyed, asWritten),
    otherLines: countOtherLines(before, after),
  }
}

/** What the editor sends back for an entry it opened and saved unedited. */
function savedEntry(doc: ContentDocument): SerializableEntry {
  if (doc.format === 'json') return { format: 'json', data: doc.data }
  if (doc.format === 'yaml') return { format: 'yaml', data: doc.data }
  return { format: doc.format, data: doc.data, body: doc.body }
}

/**
 * The `_key`s `keyed` holds that `asWritten` lacks or holds differently. `withItemKeys` returns
 * every subtree it left alone as the same object, so the walk skips those.
 */
function countAddedKeys(keyed: unknown, asWritten: unknown): number {
  if (keyed === asWritten) return 0
  if (Array.isArray(keyed)) {
    const was = Array.isArray(asWritten) ? asWritten : []
    return keyed.reduce<number>((n, value, i) => n + countAddedKeys(value, was[i]), 0)
  }
  if (!isPlainRecord(keyed)) return 0
  const was = isPlainRecord(asWritten) ? asWritten : {}
  let count = ITEM_KEY in keyed && keyed[ITEM_KEY] !== was[ITEM_KEY] ? 1 : 0
  for (const [name, value] of Object.entries(keyed)) {
    if (name !== ITEM_KEY) count += countAddedKeys(value, was[name])
  }
  return count
}

/** A `_key` line as YAML (frontmatter included) or JSON spells it, its trailing comma trimmed. */
function isKeyLine(line: string): boolean {
  const text = line.trim().replace(/^-\s/, '').trimStart()
  for (const name of ['_key:', '"_key":']) {
    if (text.startsWith(name)) return /^\s*\S+$/.test(text.slice(name.length))
  }
  return false
}

/**
 * Lines changed between `before` and `after` other than added `_key` lines. Trailing commas are
 * ignored, since a JSON key appended to an object adds one to the line above it.
 */
function countOtherLines(before: string, after: string): number {
  const lines = (text: string) =>
    text.split(/\r?\n/).map((line) => line.trimEnd().replace(/,$/, ''))
  let other = 0
  for (const change of diffArrays(lines(before), lines(after))) {
    if (change.removed) other += change.value.length
    else if (change.added) other += change.value.filter((line) => !isKeyLine(line)).length
  }
  return other
}

export interface BackfillItemKeysCLIOptions {
  projectDir: string
  /** Directory holding `schemas.ts`, relative to the project. Default `app`. */
  appDir?: string
  check?: boolean
  /** Write even when the content tree has uncommitted changes. */
  force?: boolean
}

/**
 * Exit codes. `--check`: 0 when no file needs keys, 1 when some would change. A run: 0 when done,
 * 1 when it would not write over uncommitted content. Both: 2 when the site's config, schema or
 * an entry could not be loaded, or an entry could not be written.
 * @internal Exported for tests.
 */
export const BACKFILL_EXIT_CODES = { ok: 0, changesOrRefused: 1, loadError: 2 } as const

/** Runs the command and returns its exit code. */
export async function backfillItemKeysCLI(options: BackfillItemKeysCLIOptions): Promise<number> {
  const { projectDir, appDir = 'app', check = false, force = false } = options
  console.log('\nCanopyCMS backfill-item-keys\n')

  let contentRootName: string
  let registry: Record<string, unknown>
  try {
    const { server } = await importSiteServerConfig(projectDir)
    const contentRoot: unknown = isPlainRecord(server) ? (server.contentRoot ?? 'content') : null
    if (typeof contentRoot !== 'string') {
      throw new Error('canopycms.config.ts does not export a config made by defineCanopyConfig().')
    }
    contentRootName = contentRoot
    registry = (await importSiteEntrySchemaRegistry(projectDir, appDir)).registry
  } catch (err) {
    console.error(`Could not load the site: ${getErrorMessage(err)}`)
    return BACKFILL_EXIT_CODES.loadError
  }

  let flatSchema: FlatSchemaItem[]
  try {
    const contentDir = path.join(projectDir, contentRootName)
    const resolved = await resolveSchema(contentDir, registry as EntrySchemaRegistry, {
      unknownSchema: 'degrade',
    })
    if (!isValidSchema(resolved.schema)) {
      throw new Error(`No .collection.json files describe ${contentRootName}/.`)
    }
    for (const issue of resolved.issues) console.warn(`  Warning: ${issue.message}`)
    flatSchema = flattenSchema(resolved.schema, contentRootName)
  } catch (err) {
    console.error(`Could not load the schema: ${getErrorMessage(err)}`)
    return BACKFILL_EXIT_CODES.loadError
  }

  if (!check && !force) {
    const refusal = await uncommittedContent(projectDir, contentRootName)
    if (refusal) {
      console.error(refusal)
      return BACKFILL_EXIT_CODES.changesOrRefused
    }
  }

  const metaDir = path.join(projectDir, CANOPY_META_DIR)
  const metaDirExisted = await filePathExists(metaDir)
  let result: BackfillResult
  try {
    result = await backfillItemKeys({ root: projectDir, flatSchema, contentRootName, check })
  } finally {
    // Outside a branch workspace nothing reads the store's generation marker, and an adopter's
    // .gitignore need not cover `.canopy-meta/`: remove what this run created there.
    if (!check && !metaDirExisted) await removeOwnMetaDir(projectDir, metaDir)
  }

  printResult(result, check)
  if (result.failed.length > 0) return BACKFILL_EXIT_CODES.loadError
  if (check && result.changed.length > 0) return BACKFILL_EXIT_CODES.changesOrRefused
  return BACKFILL_EXIT_CODES.ok
}

/** Why a run must not write: the content tree has uncommitted changes, or no git to ask. */
async function uncommittedContent(
  projectDir: string,
  contentRootName: string,
): Promise<string | null> {
  let status: string
  try {
    status = await simpleGit({ baseDir: projectDir }).raw([
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      contentRootName,
    ])
  } catch (err) {
    return (
      `Could not ask git whether ${contentRootName}/ has uncommitted changes ` +
      `(${getErrorMessage(err)}). Run inside the site's git checkout, or pass --force.`
    )
  }
  const dirty = status.split('\n').filter((line) => line.trim() !== '')
  if (dirty.length === 0) return null
  const shown = dirty.slice(0, 10).map((line) => `    ${line}`)
  if (dirty.length > shown.length) shown.push(`    … and ${dirty.length - shown.length} more`)
  return (
    `${contentRootName}/ has uncommitted changes, so the backfill's own changes could not be ` +
    `reviewed apart from them:\n${shown.join('\n')}\n` +
    'Commit or stash them first, or pass --force.'
  )
}

async function removeOwnMetaDir(projectDir: string, metaDir: string): Promise<void> {
  try {
    await fs.rm(contentIndexGenerationPath(projectDir), { force: true })
    await fs.rmdir(metaDir)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    console.warn(`  Left ${CANOPY_META_DIR}/ in place: ${getErrorMessage(err)}`)
  }
}

function printResult(result: BackfillResult, check: boolean): void {
  const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`
  const keysOnly = result.changed.filter((file) => file.otherLines === 0)
  const normalised = result.changed.filter((file) => file.otherLines > 0)
  const verb = check ? 'Would key' : 'Keyed'

  if (keysOnly.length > 0) {
    console.log(`  ${verb} items in ${plural(keysOnly.length, 'file')}, adding only _key lines:`)
    for (const file of keysOnly) console.log(`    ${file.path}  ${plural(file.itemsKeyed, 'item')}`)
  }
  if (normalised.length > 0) {
    console.log(
      `\n  ${verb} items in ${plural(normalised.length, 'file')} that an unedited save also ` +
        'normalises in other lines. Review these before committing:',
    )
    for (const file of normalised) {
      console.log(
        `    ${file.path}  ${plural(file.itemsKeyed, 'item')}, ` +
          `${plural(file.otherLines, 'other line')}`,
      )
    }
  }
  if (result.unavailable.length > 0) {
    console.warn(
      `\n  Skipped ${plural(result.unavailable.length, 'entry', 'entries')} whose entry type the schema ` +
        'registry does not have.',
    )
  }
  if (result.malformed.length > 0) {
    console.warn(
      `\n  Skipped ${plural(result.malformed.length, 'file')} that look like entries but whose ` +
        `names don't parse:\n${result.malformed.map((file) => `    ${file}`).join('\n')}`,
    )
  }
  if (result.failed.length > 0) {
    console.error(
      `\n  Could not ${check ? 'check' : 'key'} ${plural(result.failed.length, 'file')}:`,
    )
    for (const file of result.failed) console.error(`    ${file.path}: ${file.error}`)
  }

  if (result.changed.length === 0) {
    console.log('  Every item already has its key.')
  } else if (check) {
    console.log(`\n  Run \`canopycms backfill-item-keys\` to write them.`)
  } else {
    console.log('\n  Commit these changes on their own, so the commit holds nothing else.')
  }
  console.log('')
}
