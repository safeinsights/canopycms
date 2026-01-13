import { z } from 'zod'
import type { CanopyUserId, CanopyGroupId } from './types'

/**
 * Schema for .canopycms/groups.json
 */
export const GroupsFileSchema = z.object({
  version: z.literal(1),
  contentVersion: z.number().optional(), // For optimistic locking
  updatedAt: z.string().datetime(),
  updatedBy: z.string() as z.ZodType<CanopyUserId>,
  groups: z.array(
    z.object({
      id: z.string() as z.ZodType<CanopyGroupId>,
      name: z.string().min(1),
      description: z.string().optional(),
      members: z.array(z.string() as z.ZodType<CanopyUserId>),
    }),
  ),
})

export type GroupsFile = z.infer<typeof GroupsFileSchema>

export interface InternalGroup {
  id: CanopyGroupId
  name: string
  description?: string
  members: CanopyUserId[]
}

/**
 * Default groups file
 */
export const createDefaultGroupsFile = (userId: CanopyUserId): GroupsFile => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: userId,
  groups: [],
})
