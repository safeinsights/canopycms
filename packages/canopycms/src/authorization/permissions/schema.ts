/**
 * Schema for permissions.json file
 */

import { z } from 'zod'
import type { CanopyUserId, CanopyGroupId } from '../../types'

const permissionTargetSchema = z.object({
  allowedUsers: z.array(z.string() as z.ZodType<CanopyUserId>).optional(),
  allowedGroups: z.array(z.string() as z.ZodType<CanopyGroupId>).optional(),
})

/**
 * Schema for .canopycms/permissions.json
 */
export const PermissionsFileSchema = z.object({
  version: z.literal(1),
  contentVersion: z.number().optional(), // For optimistic locking
  updatedAt: z.string().datetime(),
  updatedBy: z.string() as z.ZodType<CanopyUserId>,
  pathPermissions: z.array(
    z.object({
      path: z.string().min(1),
      read: permissionTargetSchema.optional(),
      edit: permissionTargetSchema.optional(),
      review: permissionTargetSchema.optional(),
    })
  ),
})

export type PermissionsFile = z.infer<typeof PermissionsFileSchema>

/**
 * Default permissions file
 */
export function createDefaultPermissionsFile(userId: CanopyUserId): PermissionsFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
    pathPermissions: [],
  }
}
