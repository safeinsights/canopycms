/**
 * Path utilities for CanopyCMS
 *
 * This module consolidates path handling utilities that were previously
 * scattered across multiple files:
 * - normalize.ts: Path normalization and creation
 * - validation.ts: Security validation for paths
 * - branch.ts: Branch workspace path resolution
 * - types.ts: Branded types for type safety
 *
 * Usage:
 * ```ts
 * import { normalizeFilesystemPath, createLogicalPath, isValidSlug } from '../paths'
 * ```
 */

// Types
export type {
  LogicalPath,
  PhysicalPath,
  CollectionPath,
  SanitizedBranchName,
  PathContext,
  PathValidationResult,
} from './types'

// Normalization utilities (client-safe)
export {
  normalizeFilesystemPath,
  normalizeCollectionId,
  hasTraversalSequence,
  createLogicalPath,
  createPhysicalPath,
  toLogicalPath,
  toPhysicalPath,
  logicalPathToString,
  physicalPathToString,
  joinPath,
} from './normalize'

// Normalization utilities (server-only, requires Node.js path module)
export { validateAndNormalizePath } from './normalize-server'

// Validation utilities
export {
  isValidSlug,
  validateContentPath,
  isValidCollectionId,
  sanitizeForPath,
} from './validation'

// Path resolution utilities
export { resolveLogicalPath } from './resolve'

// Branch path utilities
export {
  resolveBranchPath,
  ensureBranchRoot,
  getDefaultBranchBase,
  resolveBranchPaths,
  sanitizeBranchName,
  BranchPathError,
  type BranchPathOptions,
  type BranchPathResult,
} from './branch'
