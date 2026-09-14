/**
 * Test utilities for path types.
 *
 * These are unsafe casts with NO validation. Import only from test files.
 * For production code, use the parse* or create* functions instead.
 */

import type { BranchName, ContentId, LogicalPath, PhysicalPath, Slug } from './types'

export const unsafeAsLogicalPath = (path: string): LogicalPath => path as LogicalPath

export const unsafeAsPhysicalPath = (path: string): PhysicalPath => path as PhysicalPath

export const unsafeAsSlug = (slug: string): Slug => slug as Slug

export const unsafeAsBranchName = (name: string): BranchName => name as BranchName

export const unsafeAsContentId = (id: string): ContentId => id as ContentId
