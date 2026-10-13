import type { LogicalPath } from '../../paths/types'
import type { CreateCollectionInput, UpdateCollectionInput } from '../../schema/schema-store-types'
import type { EditorCollection } from '../Editor'

/**
 * What was sent by a collection create or details save that got no answer, kept until the content
 * tree shows it landed or the user discards it, so the dialog can fill it in again.
 */
export type CollectionDraft = { branch: string } & (
  | { kind: 'create'; input: CreateCollectionInput }
  | { kind: 'details'; collectionPath: LogicalPath; updates: UpdateCollectionInput }
)

/** The directory name in a logical path, without its embedded id ("posts.abc123" -> "posts"). */
export function slugOf(logicalPath: LogicalPath): string {
  const pathParts = logicalPath.split('/')
  const lastPart = pathParts[pathParts.length - 1]
  return lastPart?.split('.')[0] || ''
}

function findByPath(
  collections: readonly EditorCollection[],
  path: LogicalPath,
): EditorCollection | undefined {
  for (const collection of collections) {
    if (collection.path === path) return collection
    const nested = collection.children && findByPath(collection.children, path)
    if (nested) return nested
  }
  return undefined
}

/** The collection named `name` directly under `parentPath`, or at the top level without one. */
function findCollectionByName(
  collections: readonly EditorCollection[],
  parentPath: LogicalPath | undefined,
  name: string,
): EditorCollection | undefined {
  const siblings = parentPath ? (findByPath(collections, parentPath)?.children ?? []) : collections
  return siblings.find((c) => c.type === 'collection' && c.name === name)
}

/**
 * Whether the tree shows a details save: its collection holds every value it sent, or, for a save
 * that changed the slug, is gone from its old path.
 */
function detailsLanded(
  collections: readonly EditorCollection[],
  draft: Extract<CollectionDraft, { kind: 'details' }>,
): boolean {
  const { updates } = draft
  const collection = findByPath(collections, draft.collectionPath)
  if (!collection) return updates.slug !== undefined && collections.length > 0
  return (
    (updates.name === undefined || collection.name === updates.name) &&
    (updates.label === undefined || (collection.label ?? '') === updates.label) &&
    (updates.slug === undefined || slugOf(collection.path) === updates.slug)
  )
}

/** Whether `collections`, read from the draft's branch, show the draft's write. */
export function collectionDraftLanded(
  collections: readonly EditorCollection[],
  draft: CollectionDraft,
): boolean {
  return draft.kind === 'create'
    ? !!findCollectionByName(collections, draft.input.parentPath, draft.input.name)
    : detailsLanded(collections, draft)
}
