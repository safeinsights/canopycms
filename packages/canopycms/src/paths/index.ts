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

// Normalization utilities
export {
  normalizeFilesystemPath,
  normalizeCollectionId,
  validateAndNormalizePath,
  hasTraversalSequence,
  createLogicalPath,
  createPhysicalPath,
  logicalPathToString,
  physicalPathToString,
  joinPath,
} from './normalize'

// Validation utilities
export {
  isValidSlug,
  validateContentPath,
  isValidCollectionId,
  sanitizeForPath,
} from './validation'

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
