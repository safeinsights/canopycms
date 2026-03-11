/**
 * Zod schemas for branded type validation at API boundaries.
 *
 * These schemas validate incoming strings from HTTP requests
 * and cast them to branded types for type-safe handling in API handlers.
 *
 * Usage:
 * ```ts
 * import { branchNameSchema, logicalPathSchema } from './validators'
 *
 * const paramsSchema = z.object({
 *   branch: branchNameSchema,
 *   path: logicalPathSchema,
 * })
 *
 * // TypeScript infers branded types automatically
 * const params = paramsSchema.parse(req.params)
 * // params.branch is BranchName (not string)
 * // params.path is LogicalPath (not string)
 * ```
 */

import { z } from 'zod'
import {
  parseBranchName,
  parseLogicalPath,
  parseContentId,
  parseSlug,
  type BranchName,
  type LogicalPath,
  type ContentId,
  type EntrySlug,
  type CollectionSlug,
} from '../paths'
import { parsePermissionPath, type PermissionPath } from '../authorization'

/**
 * Zod schema for BranchName - validates git branch naming rules and brands.
 *
 * Validates:
 * - No empty strings
 * - No double dots (..)
 * - No leading/trailing slashes
 * - No spaces
 * - No leading/trailing dots
 * - No @{ sequences
 */
export const branchNameSchema = z.string().min(1).transform((val, ctx) => {
  const result = parseBranchName(val)
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    })
    return z.NEVER
  }
  return result.name
}) as unknown as z.ZodType<BranchName>

/**
 * Zod schema for LogicalPath - validates and brands logical content paths.
 *
 * Validates:
 * - No empty strings
 * - No path traversal sequences (..)
 * - Not a physical path (no embedded content IDs)
 */
export const logicalPathSchema = z.string().min(1).transform((val, ctx) => {
  const result = parseLogicalPath(val)
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    })
    return z.NEVER
  }
  return result.path
}) as unknown as z.ZodType<LogicalPath>

/**
 * Zod schema for ContentId - validates 12-char Base58 IDs.
 *
 * Validates:
 * - Exactly 12 characters
 * - Base58 alphabet only (no 0, O, I, l)
 */
export const contentIdSchema = z.string().transform((val, ctx) => {
  const result = parseContentId(val)
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    })
    return z.NEVER
  }
  return result.id
}) as unknown as z.ZodType<ContentId>

/**
 * Zod schema for EntrySlug - validates entry slugs.
 *
 * Validates:
 * - No path separators (/ or \)
 * - Starts with lowercase letter or number
 * - Only lowercase letters, numbers, and hyphens
 * - Max 64 characters
 */
export const entrySlugSchema = z.string().min(1).transform((val, ctx) => {
  const result = parseSlug(val, 'entry')
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    })
    return z.NEVER
  }
  return result.slug as EntrySlug
}) as unknown as z.ZodType<EntrySlug>

/**
 * Zod schema for CollectionSlug - validates collection slugs.
 *
 * Validates:
 * - No path separators (/ or \)
 * - Starts with lowercase letter or number
 * - Only lowercase letters, numbers, and hyphens
 * - Max 64 characters
 */
export const collectionSlugSchema = z.string().min(1).transform((val, ctx) => {
  const result = parseSlug(val, 'collection')
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    })
    return z.NEVER
  }
  return result.slug as CollectionSlug
}) as unknown as z.ZodType<CollectionSlug>

/**
 * Zod schema for PermissionPath - validates permission rule paths.
 *
 * SECURITY: Prevents path traversal attacks in permission rules.
 *
 * Validates:
 * - No path traversal sequences (..)
 * - No leading/trailing slashes
 * - No consecutive slashes
 */
export const permissionPathSchema = z.string().min(1).transform((val, ctx) => {
  const result = parsePermissionPath(val)
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    })
    return z.NEVER
  }
  return result.path
}) as unknown as z.ZodType<PermissionPath>
