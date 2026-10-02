/**
 * Zod schemas for branded type validation at API boundaries.
 *
 * These schemas validate incoming strings from HTTP requests
 * and cast them to branded types for type-safe handling in API handlers.
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
  type Slug,
} from '../paths'
import { parsePermissionPath, type PermissionPath } from '../authorization'

/**
 * Zod schema for BranchName: validates and brands a branch-name string via `parseBranchName`
 * (paths/validation.ts), so handlers receive a `BranchName`, not a bare `string`.
 */
export const branchNameSchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
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
 * Zod schema for LogicalPath: validates and brands via `parseLogicalPath` (paths/validation.ts),
 * which blocks path-traversal sequences and physical-path shapes, so handlers get a
 * `LogicalPath`, not a bare `string`.
 */
export const logicalPathSchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
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
 * Zod schema for ContentId: validates and brands a 12-char Base58 ID via `parseContentId`
 * (paths/validation.ts), so handlers get a `ContentId`, not a bare `string`.
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
 * Zod schema for Slug: validates and brands via `parseSlug` (paths/validation.ts), so handlers
 * get a `Slug`, not a bare `string`.
 */
export const slugSchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
    const result = parseSlug(val)
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error,
      })
      return z.NEVER
    }
    return result.slug
  }) as unknown as z.ZodType<Slug>

/**
 * Common params schema for endpoints that accept a branch name path parameter.
 * Shared across branch-status, branch-review, branch-withdraw, comments, and branch handlers.
 */
export const branchParamSchema = z.object({
  branch: branchNameSchema,
})

/**
 * Zod schema for PermissionPath: validates and brands via `parsePermissionPath`
 * (authorization/validation.ts), so handlers get a `PermissionPath`, not a bare `string`.
 * SECURITY: this is what blocks path traversal (`..`) in permission-rule paths.
 */
export const permissionPathSchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
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

/**
 * Zod schema for boolean GET query params. HTTP query strings always arrive as
 * strings, so this accepts 'true'/'false' alongside real booleans (programmatic
 * validate() calls). NOT z.coerce.boolean(), which coerces 'false' to true.
 */
export const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true')
