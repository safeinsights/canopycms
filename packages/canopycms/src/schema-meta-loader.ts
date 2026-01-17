/**
 * Schema Meta Loader
 *
 * This file re-exports from the schema module for backward compatibility.
 * New code should import directly from './schema' or './schema/meta-loader'.
 *
 * @deprecated Import from './schema' instead
 */

export {
  loadCollectionMetaFiles,
  resolveCollectionReferences,
  watchCollectionMetaFiles,
  type CollectionMeta,
  type RootCollectionMeta,
} from './schema/meta-loader'
