/**
 * Integration tests for Groups API endpoints
 *
 * These tests verify that the Groups API works correctly with settings stored
 * in the new settings directory structure across all operating modes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import { createCanopyServices } from '../../services'
import { createMockApiContext } from '../../test-utils/api-test-helpers'
import { RESERVED_GROUPS } from '../../reserved-groups'
import { GROUP_ROUTES } from '../../api/groups'
import type { InternalGroup } from '../../groups-file'
import { operatingStrategy } from '../../operating-mode'

// Extract handlers
const getInternalGroups = GROUP_ROUTES.getInternal.handler
const updateInternalGroups = GROUP_ROUTES.updateInternal.handler

describe('Groups API Integration', () => {
  describe('prod-sim mode', () => {
    let workspace: TestWorkspace

    beforeEach(async () => {
      workspace = await createTestWorkspace({
        schema: BLOG_SCHEMA,
        mode: 'prod-sim',
      })
    })

    afterEach(async () => {
      await workspace.cleanup()
    })

    it('should load groups from settings directory', async () => {
      // Create services
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      // Call the groups API
      const result = await getInternalGroups(context, {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      })

      expect(result.ok).toBe(true)
      if (result.ok && result.data) {
        expect(result.data.groups).toBeDefined()
        expect(Array.isArray(result.data.groups)).toBe(true)
        // Should have at least Admins and Reviewers groups
        expect(result.data.groups.length).toBeGreaterThanOrEqual(2)

        const adminsGroup = result.data.groups.find((g) => g.id === RESERVED_GROUPS.ADMINS)
        expect(adminsGroup).toBeDefined()
        expect(adminsGroup?.name).toBe(RESERVED_GROUPS.ADMINS)
      }
    })

    it('should save groups to settings directory', async () => {
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      // Create new groups
      const newGroups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS,
          name: RESERVED_GROUPS.ADMINS,
          description: 'Full access',
          members: ['admin-1'],
        },
        {
          id: RESERVED_GROUPS.REVIEWERS,
          name: RESERVED_GROUPS.REVIEWERS,
          description: 'Can review',
          members: [],
        },
        {
          id: 'editors',
          name: 'Editors',
          description: 'Can edit content',
          members: ['user-1', 'user-2'],
        },
      ]

      // Update groups
      const result = await updateInternalGroups(
        context,
        { user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] } },
        { groups: newGroups },
      )

      expect(result.ok).toBe(true)

      // Verify file exists at correct path
      const strategy = operatingStrategy('prod-sim')
      const settingsRoot = strategy.getSettingsRoot(workspace.tmpRoot)
      const groupsPath = path.join(settingsRoot, 'groups.json')

      const fileExists = await fs.access(groupsPath).then(
        () => true,
        () => false,
      )
      expect(fileExists).toBe(true)

      // Verify file content
      const fileContent = await fs.readFile(groupsPath, 'utf-8')
      const parsed = JSON.parse(fileContent)
      expect(parsed.groups).toBeDefined()
      expect(parsed.groups.length).toBe(3)

      const editorsGroup = parsed.groups.find((g: InternalGroup) => g.id === 'editors')
      expect(editorsGroup).toBeDefined()
      expect(editorsGroup.members).toEqual(['user-1', 'user-2'])
    })

    it('should handle concurrent group loads without race conditions', async () => {
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      // Make 5 concurrent requests
      const promises = Array.from({ length: 5 }, () =>
        getInternalGroups(context, {
          user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
        }),
      )

      const results = await Promise.all(promises)

      // All should succeed
      results.forEach((result) => {
        expect(result.ok).toBe(true)
        if (result.ok && result.data) {
          expect(result.data.groups.length).toBeGreaterThanOrEqual(2)
        }
      })
    })

    it('should preserve groups across service restarts', async () => {
      // Create services and save groups
      const services1 = createCanopyServices(workspace.config)
      const context1 = createMockApiContext({ services: services1 })

      const customGroups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS,
          name: RESERVED_GROUPS.ADMINS,
          description: 'Admins',
          members: ['admin-1'],
        },
        {
          id: RESERVED_GROUPS.REVIEWERS,
          name: RESERVED_GROUPS.REVIEWERS,
          description: 'Reviewers',
          members: [],
        },
        {
          id: 'custom-group',
          name: 'Custom Group',
          description: 'A custom group',
          members: ['user-1', 'user-2', 'user-3'],
        },
      ]

      await updateInternalGroups(
        context1,
        { user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] } },
        { groups: customGroups },
      )

      // Create new services instance (simulating restart)
      const services2 = createCanopyServices(workspace.config)
      const context2 = createMockApiContext({ services: services2 })

      // Load groups with new services
      const result = await getInternalGroups(context2, {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      })

      expect(result.ok).toBe(true)
      if (result.ok && result.data) {
        const customGroup = result.data.groups.find((g) => g.id === 'custom-group')
        expect(customGroup).toBeDefined()
        expect(customGroup?.members).toEqual(['user-1', 'user-2', 'user-3'])
      }
    })
  })

  describe('dev mode', () => {
    let workspace: TestWorkspace

    beforeEach(async () => {
      workspace = await createTestWorkspace({
        schema: BLOG_SCHEMA,
        mode: 'dev',
      })
    })

    afterEach(async () => {
      await workspace.cleanup()
    })

    it('should load groups from dev settings directory', async () => {
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      const result = await getInternalGroups(context, {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      })

      expect(result.ok).toBe(true)
      if (result.ok && result.data) {
        expect(result.data.groups).toBeDefined()
        expect(result.data.groups.length).toBeGreaterThanOrEqual(2)
      }
    })

    it('should save groups to .canopy-dev/settings directory', async () => {
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      const newGroups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS,
          name: RESERVED_GROUPS.ADMINS,
          description: 'Admins',
          members: ['admin-1'],
        },
        {
          id: RESERVED_GROUPS.REVIEWERS,
          name: RESERVED_GROUPS.REVIEWERS,
          description: 'Reviewers',
          members: [],
        },
      ]

      await updateInternalGroups(
        context,
        { user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] } },
        { groups: newGroups },
      )

      // Verify file exists at correct path in dev mode
      const strategy = operatingStrategy('dev')
      const settingsRoot = strategy.getSettingsRoot(workspace.tmpRoot)
      const groupsPath = path.join(settingsRoot, 'groups.json')

      const fileExists = await fs.access(groupsPath).then(
        () => true,
        () => false,
      )
      expect(fileExists).toBe(true)
    })
  })

  describe('permissions checking', () => {
    let workspace: TestWorkspace

    beforeEach(async () => {
      workspace = await createTestWorkspace({
        schema: BLOG_SCHEMA,
        mode: 'prod-sim',
      })
    })

    afterEach(async () => {
      await workspace.cleanup()
    })

    it('should deny access to non-admin users for getting groups', async () => {
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      const result = await getInternalGroups(context, {
        user: { type: 'authenticated', userId: 'regular-user', groups: [] },
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })

    it('should deny access to non-admin users for updating groups', async () => {
      const services = createCanopyServices(workspace.config)
      const context = createMockApiContext({ services })

      const newGroups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS,
          name: RESERVED_GROUPS.ADMINS,
          description: 'Admins',
          members: ['admin-1'],
        },
        {
          id: RESERVED_GROUPS.REVIEWERS,
          name: RESERVED_GROUPS.REVIEWERS,
          description: 'Reviewers',
          members: [],
        },
      ]

      const result = await updateInternalGroups(
        context,
        { user: { type: 'authenticated', userId: 'regular-user', groups: [] } },
        { groups: newGroups },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })
  })
})
