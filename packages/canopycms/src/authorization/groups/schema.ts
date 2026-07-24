/**
 * Schema for groups.json file
 */

import { z } from 'zod'
import type { CanopyUserId, CanopyGroupId } from '../../types'

/**
 * Schema for .canopycms/groups.json
 */
export const GroupsFileSchema = z.object({
  // Managed by writeOccJsonFile (see authorization/settings-file-store.ts) —
  // the single OCC counter for this file. Optional so a hand-written file
  // with no version field parses as version 0. A legacy `contentVersion`
  // field (if present) is silently stripped by this non-strict zod parse.
  version: z.number().int().nonnegative().optional(),
  writeId: z.string().optional(),
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

/**
 * Internal group representation
 */
export interface InternalGroup {
  id: CanopyGroupId
  name: string
  description?: string
  members: CanopyUserId[]
}

/**
 * Default groups file. Omits `version`/`writeId` — the writer
 * (mutateSettingsJsonFile via writeOccJsonFile) manages those.
 */
export function createDefaultGroupsFile(userId: CanopyUserId): GroupsFile {
  return {
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
    groups: [],
  }
}
