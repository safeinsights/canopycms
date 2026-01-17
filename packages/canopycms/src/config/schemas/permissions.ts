/**
 * Zod schemas for permission configuration validation.
 */

import { z } from 'zod'

import type { CanopyGroupId, CanopyUserId } from '../../types'

// Permission target schema
export const permissionTargetSchema = z.object({
  allowedUsers: z.array(z.string() as z.ZodType<CanopyUserId>).optional(),
  allowedGroups: z.array(z.string() as z.ZodType<CanopyGroupId>).optional(),
})

// Path permission schema
export const pathPermissionSchema = z.object({
  path: z.string().min(1),
  read: permissionTargetSchema.optional(),
  edit: permissionTargetSchema.optional(),
  review: permissionTargetSchema.optional(),
})
