/**
 * Path utilities. Client-reachable code deep-imports `./branch-name` instead,
 * because this barrel pulls in node:fs; `pnpm lint:bundle` enforces that.
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
export {
  sanitizeBranchName,
  RESERVED_SETTINGS_BRANCH_PREFIX,
  RESERVED_ROUTE_BRANCH_NAMES,
} from './branch-name'
