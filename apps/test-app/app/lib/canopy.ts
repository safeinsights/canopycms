import { createNextCanopyContext } from 'canopycms-next'
import type { AuthPlugin, AuthenticationResult } from 'canopycms/auth'
import { extractHeaders } from 'canopycms/auth'
import config from '../../canopycms.config'

/**
 * Test users for E2E testing.
 * Switch users via X-Test-User header (e.g., 'admin', 'editor', 'viewer').
 */
const TEST_USERS: Record<
  string,
  {
    userId: string
    email: string
    name: string
    externalGroups: string[]
  }
> = {
  admin: {
    userId: 'test-admin',
    email: 'admin@test.local',
    name: 'Test Admin',
    externalGroups: [], // Bootstrap admin will add 'Admins' group
  },
  editor: {
    userId: 'test-editor',
    email: 'editor@test.local',
    name: 'Test Editor',
    externalGroups: ['Editors'],
  },
  viewer: {
    userId: 'test-viewer',
    email: 'viewer@test.local',
    name: 'Test Viewer',
    externalGroups: [],
  },
}

/**
 * Mock auth plugin for E2E testing.
 * Supports user switching via X-Test-User header. Defaults to 'admin'.
 */
const mockAuthPlugin: AuthPlugin = {
  async authenticate(context: unknown): Promise<AuthenticationResult> {
    const headers = extractHeaders(context)
    if (!headers) {
      return { success: false, error: 'Invalid context' }
    }

    const userKey = headers.get('X-Test-User') ?? 'admin'
    const userData = TEST_USERS[userKey] ?? TEST_USERS.admin

    return {
      success: true,
      user: userData,
    }
  },
  async searchUsers() {
    return []
  },
  async getUserMetadata() {
    return null
  },
  async getGroupMetadata() {
    return null
  },
  async listGroups() {
    return []
  },
  async searchExternalGroups() {
    return []
  },
}

const canopyContext = createNextCanopyContext({
  config: config.server,
  authPlugin: mockAuthPlugin,
})

export const getCanopy = canopyContext.getCanopy
export const handler = canopyContext.handler
