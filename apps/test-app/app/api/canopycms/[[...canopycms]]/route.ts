import { createCanopyCatchAllHandler } from 'canopycms-next'
import type { AuthPlugin, AuthenticatedUser, TokenVerificationResult } from 'canopycms'
import type { CanopyRequest } from 'canopycms/http'
import config from '../../../../canopycms.config'

/**
 * Test users for E2E testing.
 * Switch users via X-Test-User header (e.g., 'admin', 'editor', 'viewer').
 */
const TEST_USERS: Record<string, AuthenticatedUser> = {
  admin: {
    type: 'authenticated',
    userId: 'test-admin',
    email: 'admin@test.local',
    name: 'Test Admin',
    groups: ['Admins'],
  },
  editor: {
    type: 'authenticated',
    userId: 'test-editor',
    email: 'editor@test.local',
    name: 'Test Editor',
    groups: ['Editors'],
  },
  viewer: {
    type: 'authenticated',
    userId: 'test-viewer',
    email: 'viewer@test.local',
    name: 'Test Viewer',
    groups: [],
  },
}

/**
 * Mock auth plugin for E2E testing.
 * Supports user switching via X-Test-User header. Defaults to 'admin'.
 */
const mockAuthPlugin: AuthPlugin = {
  async verifyToken(req: CanopyRequest): Promise<TokenVerificationResult> {
    const userKey = req.header('X-Test-User') ?? 'admin'
    const user = TEST_USERS[userKey] ?? TEST_USERS.admin
    return { valid: true, user }
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

const handler = createCanopyCatchAllHandler({
  config: config.server,
  authPlugin: mockAuthPlugin,
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
