import type { Page } from '@playwright/test'

/**
 * Test users available in the mock auth system.
 * These match the users configured in the test-app's mock auth plugin.
 * The X-Test-User header should be set to the key (e.g., 'admin', 'editor').
 */
export const TEST_USERS = {
  admin: {
    userId: 'test-admin',
    groups: ['Admins'], // Bootstrap admin adds this
    displayName: 'Test Admin',
  },
  editor: {
    userId: 'test-editor',
    groups: ['Editors'],
    displayName: 'Test Editor',
  },
  viewer: {
    userId: 'test-viewer',
    groups: [],
    displayName: 'Test Viewer',
  },
  reviewer: {
    userId: 'test-reviewer',
    groups: ['Reviewers'],
    displayName: 'Test Reviewer',
  },
} as const

export type TestUserId = keyof typeof TEST_USERS

/**
 * Switch the current user context by setting the X-Test-User header.
 * This works with the mock auth plugin in the test-app.
 *
 * @param page - Playwright page instance
 * @param userId - The user ID to switch to
 */
export async function switchUser(page: Page, userId: TestUserId): Promise<void> {
  await page.setExtraHTTPHeaders({
    'X-Test-User': userId,
  })
}

/**
 * Get the current test user's information.
 *
 * @param userId - The user ID
 * @returns User information including groups
 */
export function getTestUser(userId: TestUserId) {
  return TEST_USERS[userId]
}

/**
 * Check if a user has admin privileges.
 *
 * @param userId - The user ID to check
 * @returns True if user is in Admins group
 */
export function isAdmin(userId: TestUserId): boolean {
  return TEST_USERS[userId].groups.includes('Admins')
}

/**
 * Check if a user has reviewer privileges.
 *
 * @param userId - The user ID to check
 * @returns True if user is in Reviewers group
 */
export function isReviewer(userId: TestUserId): boolean {
  return TEST_USERS[userId].groups.includes('Reviewers')
}

/**
 * Check if a user is privileged (admin or reviewer).
 *
 * @param userId - The user ID to check
 * @returns True if user is admin or reviewer
 */
export function isPrivileged(userId: TestUserId): boolean {
  return isAdmin(userId) || isReviewer(userId)
}
