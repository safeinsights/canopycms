/**
 * Test utilities for path types.
 *
 * These are unsafe casts with NO validation. Import only from test files.
 * For production code, use the parse* or create* functions instead.
 *
 * @example
 * // In test files only:
 * import { unsafeAsLogicalPath, unsafeAsEntrySlug } from '../paths/test-utils'
 */

import type {
  BranchName,
  CollectionSlug,
  ContentId,
  LogicalPath,
  PhysicalPath,
  EntrySlug,
} from './types'

/** Test-only: cast a string to LogicalPath without validation. */
export const unsafeAsLogicalPath = (path: string): LogicalPath => path as LogicalPath

/** Test-only: cast a string to PhysicalPath without validation. */
export const unsafeAsPhysicalPath = (path: string): PhysicalPath => path as PhysicalPath

/** Test-only: cast a string to EntrySlug without validation. */
export const unsafeAsEntrySlug = (slug: string): EntrySlug => slug as EntrySlug

/** Test-only: cast a string to BranchName without validation. */
export const unsafeAsBranchName = (name: string): BranchName => name as BranchName

/** Test-only: cast a string to CollectionSlug without validation. */
export const unsafeAsCollectionSlug = (slug: string): CollectionSlug => slug as CollectionSlug

/** Test-only: cast a string to ContentId without validation. */
export const unsafeAsContentId = (id: string): ContentId => id as ContentId
