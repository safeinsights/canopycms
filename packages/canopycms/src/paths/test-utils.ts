/**
 * Test utilities for path types.
 *
 * These are unsafe casts with NO validation. Import only from test files.
 * For production code, use the parse* or create* functions instead.
 *
 * @example
 * // In test files only:
 * import { unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'
 */

import type { BranchName, ContentId, LogicalPath, PhysicalPath, Slug } from './types'

/** Test-only: cast a string to LogicalPath without validation. */
export const unsafeAsLogicalPath = (path: string): LogicalPath => path as LogicalPath

/** Test-only: cast a string to PhysicalPath without validation. */
export const unsafeAsPhysicalPath = (path: string): PhysicalPath => path as PhysicalPath

/** Test-only: cast a string to Slug without validation. */
export const unsafeAsSlug = (slug: string): Slug => slug as Slug

/** Test-only: cast a string to BranchName without validation. */
export const unsafeAsBranchName = (name: string): BranchName => name as BranchName

/** Test-only: cast a string to ContentId without validation. */
export const unsafeAsContentId = (id: string): ContentId => id as ContentId
