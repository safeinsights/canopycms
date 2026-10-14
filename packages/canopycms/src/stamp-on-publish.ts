/**
 * `stampOnPublish` (config/types.ts): at submit, each entry new to the base branch gets the
 * submit's time in its empty stamp fields. Canopy never merges and never writes the base branch,
 * and adopters build from the merged tree, so its own submit is the last point it can put the
 * date into the content. An entry counts as new when the base tip holds no file with its
 * ContentId, so a renamed or moved entry, which keeps its ID, is never stamped.
 */
import path from 'node:path'

import type { EntrySchema, FlatSchemaItem } from './config'
import { listCollectionEntries, type CollectionSchemaItem } from './content-listing'
import type { ContentStore } from './content-store'
import type { GitManager } from './git-manager'
import type { ContentId } from './paths/types'
import { getErrorMessage } from './utils/error'
import { flattenGroupFields } from './utils/flatten-group-fields'
import { parseTypedFilename } from './utils/typed-filename'

/** The names of `schema`'s top-level fields that carry `stampOnPublish`. */
const stampFieldNames = (schema: EntrySchema): string[] =>
  flattenGroupFields(schema)
    .filter((f) => f.type === 'datetime' && 'stampOnPublish' in f && f.stampOnPublish === true)
    .map((f) => f.name)

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === ''

/** `contentRoot` as a repo-relative directory, or undefined when it is the repository root. */
const contentRootDir = (contentRoot: string): string | undefined =>
  contentRoot
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/') || undefined

/**
 * Fill every empty stamp field of every entry the base tip lacks with `stampedAt`, never
 * overwriting a value, and return the root-relative paths written. Lists the base only when the
 * schema has a stamp field. Rejects when the base cannot be fetched or listed; a single entry
 * that cannot be written is reported through `warn` and skipped.
 *
 * The caller holds the branch's content-write lock, as `store.fillEmptyFieldWhileHoldingWriteLock`
 * requires.
 */
export async function stampNewEntries(options: {
  git: Pick<GitManager, 'listBaseTipFiles'>
  store: ContentStore
  branchRoot: string
  flatSchema: readonly FlatSchemaItem[]
  contentRoot: string
  stampedAt: string
  warn: (message: string) => void
}): Promise<string[]> {
  const collections = options.flatSchema.filter(
    (item): item is CollectionSchemaItem =>
      item.type === 'collection' &&
      (item.entries ?? []).some((entryType) => stampFieldNames(entryType.schema).length > 0),
  )
  if (collections.length === 0) return []

  const baseIds = new Set<ContentId>()
  for (const file of await options.git.listBaseTipFiles(contentRootDir(options.contentRoot))) {
    const id = parseTypedFilename(path.posix.basename(file))?.id
    if (id) baseIds.add(id)
  }

  const stamped: string[] = []
  for (const collection of collections) {
    for (const entry of await listCollectionEntries(options.branchRoot, collection)) {
      if (baseIds.has(entry.contentId)) continue
      const schema = collection.entries?.find((e) => e.name === entry.entryType)?.schema ?? []
      const empty = stampFieldNames(schema).filter((name) => isEmpty(entry.data[name]))
      for (const field of empty) {
        try {
          const wrote = await options.store.fillEmptyFieldWhileHoldingWriteLock(
            entry.physicalPath,
            entry.format,
            field,
            options.stampedAt,
          )
          if (wrote && !stamped.includes(entry.physicalPath)) stamped.push(entry.physicalPath)
        } catch (err) {
          options.warn(
            `CanopyCMS: Could not stamp "${field}" on ${entry.physicalPath}; it is submitted ` +
              `without it: ${getErrorMessage(err)}`,
          )
        }
      }
    }
  }
  return stamped
}
