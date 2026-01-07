/**
 * Integration tests for user context API endpoint.
 * Tests the /whoami endpoint that returns current user info.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { UserInfoResponse } from '../../api/user'
import type { AuthPlugin } from '../../auth/plugin'
import type { AuthenticationResult } from '../../auth/types'

/**
 * Helper to create a mock auth plugin with custom userId and groups
 */
function createCustomAuthPlugin(userId: string, groups: string[]): AuthPlugin {
  return {
    async authenticate(_context: unknown): Promise<AuthenticationResult> {
      return {
        success: true,
        user: {
          userId: `test-${userId}`,
          email: `${userId}@test.local`,
          name: `Test ${userId}`,
          externalGroups: groups,
        },
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
}

describe('User Context API Integration', () => {
  let workspace: TestWorkspace
  let adminClient: ApiClient
  let editorClient: ApiClient
  let reviewerClient: ApiClient

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    // Create API clients for different users with different group memberships
    adminClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })

    editorClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
    })

    reviewerClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('reviewer'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('returns correct user info for admin user', async () => {
    const response = await adminClient.get('/api/canopycms/whoami')

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)

    const data = await response.json<UserInfoResponse>()
    expect(data.ok).toBe(true)
    expect(data.data?.userId).toBe('test-admin')
    expect(data.data?.groups).toContain('Admins')
  })

  it('returns correct user info for editor user', async () => {
    const response = await editorClient.get('/api/canopycms/whoami')

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)

    const data = await response.json<UserInfoResponse>()
    expect(data.ok).toBe(true)
    expect(data.data?.userId).toBe('test-editor')
    expect(data.data?.groups).toContain('ContentEditors')
  })

  it('returns correct user info for reviewer user', async () => {
    const response = await reviewerClient.get('/api/canopycms/whoami')

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)

    const data = await response.json<UserInfoResponse>()
    expect(data.ok).toBe(true)
    expect(data.data?.userId).toBe('test-reviewer')
    expect(data.data?.groups).toContain('Reviewers')
  })

  it('returns all groups when user belongs to multiple', async () => {
    // Create a client for a user with multiple groups
    const multiGroupClient = createApiClient({
      config: workspace.config,
      authPlugin: createCustomAuthPlugin('multi-group-user', ['ContentEditors', 'Reviewers']),
    })

    const response = await multiGroupClient.get('/api/canopycms/whoami')

    expect(response.status).toBe(200)
    const data = await response.json<UserInfoResponse>()
    expect(data.ok).toBe(true)
    expect(data.data?.userId).toBe('test-multi-group-user')
    expect(data.data?.groups).toContain('ContentEditors')
    expect(data.data?.groups).toContain('Reviewers')
    expect(data.data?.groups).toHaveLength(2)
  })

  it('endpoint is accessible without special permissions', async () => {
    // All authenticated users should be able to call /whoami
    const responses = await Promise.all([
      adminClient.get('/api/canopycms/whoami'),
      editorClient.get('/api/canopycms/whoami'),
      reviewerClient.get('/api/canopycms/whoami'),
    ])

    // All should succeed
    responses.forEach((response) => {
      expect(response.status).toBe(200)
      expect(response.ok).toBe(true)
    })
  })

  it('integrates with BranchManager permissions via user context', async () => {
    // Create a branch as editor
    const createResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/editor-branch',
      title: 'Test Branch',
    })
    expect(createResponse.status).toBe(200)

    // Verify the branch was created by the correct user
    const branchData = await createResponse.json<any>()
    expect(branchData.data?.branch.createdBy).toBe('test-editor')

    // Get user info to confirm it matches
    const whoamiResponse = await editorClient.get('/api/canopycms/whoami')
    const whoamiData = await whoamiResponse.json<UserInfoResponse>()

    expect(whoamiData.data?.userId).toBe('test-editor')
    expect(branchData.data?.branch.createdBy).toBe(whoamiData.data?.userId)
  })
})
