/**
 * Path utilities for CanopyCMS
 */

export type {
  LogicalPath,
  PhysicalPath,
  SanitizedBranchName,
  BranchName,
  ContentId,
  Slug,
  PathValidationResult,
} from './types'

// Normalization utilities (client-safe)
export {
  normalizeFilesystemPath,
  normalizeCollectionPath,
  hasTraversalSequence,
  createLogicalPath,
  createPhysicalPath,
  joinPath,
  trimSlashes,
} from './normalize'

// Normalization utilities (server-only, requires Node.js path module)
export { validateAndNormalizePath } from './normalize-server'

export {
  validateContentPath,
  isValidCollectionPath,
  sanitizeForPath,
  hasEmbeddedContentId,
  looksLikePhysicalPath,
  looksLikeLogicalPath,
  parseLogicalPath,
  parsePhysicalPath,
  isValidContentId,
  parseContentId,
  parseBranchName,
  parseSlug,
} from './validation'

export { resolveLogicalPath } from './resolve'

export {
  resolveBranchPath,
  ensureBranchRoot,
  getDefaultBranchBase,
  resolveBranchPaths,
  BranchPathError,
  type BranchPathOptions,
  type BranchPathResult,
} from './branch'
// From the dependency-free module (NOT ./branch, which imports node:fs) so
// client-reachable importers of 'canopycms/src/paths' stay browser-safe.
export {
  sanitizeBranchName,
  RESERVED_SETTINGS_BRANCH_PREFIX,
  RESERVED_ROUTE_BRANCH_NAMES,
} from './branch-name'
