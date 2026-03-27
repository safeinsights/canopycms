/**
 * Client-safe defaults and types for dev auth plugin.
 * This file must NOT import any server-only code (node:fs, etc.)
 * so it can be safely included in client bundles.
 */
import type { CanopyUserId, CanopyGroupId } from 'canopycms'

export interface DevUser {
  userId: CanopyUserId
  name: string
  email: string
  avatarUrl?: string
  externalGroups: CanopyGroupId[]
}

export interface DevGroup {
  id: CanopyGroupId
  name: string
  description?: string
}

export const DEV_ADMIN_USER_ID: CanopyUserId = 'dev_admin_3xY6zW1qR5'

export interface DevAuthConfig {
  /**
   * Custom mock users. If not provided, uses default users.
   */
  users?: DevUser[]

  /**
   * Custom mock groups. If not provided, uses default groups.
   */
  groups?: DevGroup[]

  /**
   * Default user ID when no user is selected.
   * @default 'dev_user1_2nK8mP4xL9' (user1)
   */
  defaultUserId?: CanopyUserId

  /**
   * Whether to auto-set CANOPY_BOOTSTRAP_ADMIN_IDS for the admin dev user
   * when the env var is not already set. Defaults to true.
   */
  autoBootstrapAdmin?: boolean
}

export const DEFAULT_USERS: DevUser[] = [
  {
    userId: 'dev_user1_2nK8mP4xL9',
    name: 'User One',
    email: 'user1@localhost.dev',
    externalGroups: ['team-a', 'team-b'],
  },
  {
    userId: 'dev_user2_7qR3tY6wN2',
    name: 'User Two',
    email: 'user2@localhost.dev',
    externalGroups: ['team-b'],
  },
  {
    userId: 'dev_user3_5vS1pM8kJ4',
    name: 'User Three',
    email: 'user3@localhost.dev',
    externalGroups: ['team-c'],
  },
  {
    userId: 'dev_reviewer_9aB4cD2eF7',
    name: 'Reviewer One',
    email: 'reviewer1@localhost.dev',
    externalGroups: ['team-a'],
    // Note: 'Reviewers' membership comes from internal groups file, not auth plugin
  },
  {
    userId: DEV_ADMIN_USER_ID,
    name: 'Admin One',
    email: 'admin1@localhost.dev',
    externalGroups: ['team-a', 'team-b', 'team-c'],
    // Note: Does NOT include 'Admins' - that's applied by bootstrap admin config or auto-bootstrap
  },
]

export const DEFAULT_GROUPS: DevGroup[] = [
  { id: 'team-a', name: 'Team A', description: 'Team A' },
  { id: 'team-b', name: 'Team B', description: 'Team B' },
  { id: 'team-c', name: 'Team C', description: 'Team C' },
]
