import { isSystemUserId } from '../system-users'

/** What the editor calls a user id CanopyCMS itself acts as (system-users.ts). */
export const SYSTEM_USER_LABEL = 'CanopyCMS bot'

/** A user id as text where no name lookup is available: a bot by its label, anyone else by id. */
export const userIdLabel = (userId: string): string =>
  isSystemUserId(userId) ? SYSTEM_USER_LABEL : userId
