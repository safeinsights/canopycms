/**
 * Schema for permissions.json file
 */

import { z } from 'zod'
import type { CanopyUserId, CanopyGroupId } from '../../types'
import { parsePermissionPath } from '../validation'
import type { PermissionPath } from '../types'

const permissionTargetSchema = z.object({
  allowedUsers: z.array(z.string() as z.ZodType<CanopyUserId>).optional(),
  allowedGroups: z.array(z.string() as z.ZodType<CanopyGroupId>).optional(),
})

/**
 * Zod schema for PermissionPath - validates and prevents path traversal attacks.
 */
const permissionPathSchema = z
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
 * Schema for .canopycms/permissions.json
 *
 * SECURITY: Permission paths are validated to prevent path traversal attacks.
 * Any path containing '..' or other traversal sequences will be rejected.
 */
export const PermissionsFileSchema = z.object({
  // Managed by writeOccJsonFile (see authorization/settings-file-store.ts) —
  // the single OCC counter for this file. Optional so a hand-written file
  // with no version field parses as version 0. A legacy `contentVersion`
  // field (if present) is silently stripped by this non-strict zod parse.
  version: z.number().int().nonnegative().optional(),
  writeId: z.string().optional(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string() as z.ZodType<CanopyUserId>,
  pathPermissions: z.array(
    z.object({
      path: permissionPathSchema,
      read: permissionTargetSchema.optional(),
      edit: permissionTargetSchema.optional(),
      review: permissionTargetSchema.optional(),
    }),
  ),
})

export type PermissionsFile = z.infer<typeof PermissionsFileSchema>

/**
 * Default permissions file. Omits `version`/`writeId` — the writer
 * (mutateSettingsJsonFile via writeOccJsonFile) manages those.
 */
export function createDefaultPermissionsFile(userId: CanopyUserId): PermissionsFile {
  return {
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
    pathPermissions: [],
  }
}
