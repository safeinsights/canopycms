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
 * import { normalizeFilesystemPath, createLogicalPath, parseSlug } from '../paths'
 * ```
 */

// Types
export type {
  LogicalPath,
  PhysicalPath,
  SanitizedBranchName,
  BranchName,
  ContentId,
  CollectionSlug,
  EntrySlug,
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
} from './normalize'

// Normalization utilities (server-only, requires Node.js path module)
export { validateAndNormalizePath } from './normalize-server'

// Validation utilities
export {
  validateContentPath,
  isValidCollectionPath,
  sanitizeForPath,
  // Path type detection and parsing
  hasEmbeddedContentId,
  looksLikePhysicalPath,
  looksLikeLogicalPath,
  parseLogicalPath,
  parsePhysicalPath,
  isValidContentId,
  // Branded type validation and parsing
  parseContentId,
  parseBranchName,
  parseSlug,
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
