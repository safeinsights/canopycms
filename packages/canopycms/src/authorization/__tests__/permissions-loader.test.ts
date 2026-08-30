import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadPathPermissions, mutatePermissionsFile, ensurePermissionsFile } from '../permissions'
import { unsafeAsPermissionPath } from '../test-utils'
import { mockConsole } from '../../test-utils/console-spy'

describe('permissions loader', () => {
  let testRoot: string

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-perms-test-'))
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  describe('loadPathPermissions', () => {
    it('loads from file when it exists', async () => {
      // Create permissions file
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(
        path.join(canopyDir, 'permissions.json'),
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin-user',
          pathPermissions: [
            {
              path: 'content/admin/**',
              edit: {},
            },
            {
              path: 'content/partners/**',
              edit: { allowedGroups: ['partner-org'] },
            },
          ],
        }),
        'utf-8',
      )

      const permissions = await loadPathPermissions(testRoot, 'prod')

      expect(permissions).toHaveLength(2)
      expect(permissions[0]).toEqual({
        path: 'content/admin/**',
        edit: {},
      })
      expect(permissions[1]).toEqual({
        path: 'content/partners/**',
        edit: { allowedGroups: ['partner-org'] },
      })
    })

    it('returns empty array when file does not exist', async () => {
      const permissions = await loadPathPermissions(testRoot, 'prod')
      expect(permissions).toEqual([])
    })

    it('throws error on invalid JSON', async () => {
      const consoleSpy = mockConsole()

      // Create invalid permissions file in new location
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(path.join(canopyDir, 'permissions.json'), 'invalid json', 'utf-8')

      await expect(loadPathPermissions(testRoot, 'prod')).rejects.toThrow(
        'Invalid permissions file',
      )
      expect(consoleSpy).toHaveErrored('Failed to parse permissions file')
      consoleSpy.restore()
    })

    it('throws error on invalid schema', async () => {
      const consoleSpy = mockConsole()

      // Create file with a structurally invalid pathPermissions field (not
      // an array). Note: `version` is no longer a discriminating literal —
      // any nonnegative integer (or a missing field) is a valid OCC version
      // now (see authorization/settings-file-store.ts).
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(
        path.join(canopyDir, 'permissions.json'),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin',
          pathPermissions: 'not-an-array',
        }),
        'utf-8',
      )

      await expect(loadPathPermissions(testRoot, 'prod')).rejects.toThrow(
        'Invalid permissions file',
      )
      expect(consoleSpy).toHaveErrored('Failed to parse permissions file')
      consoleSpy.restore()
    })

    it('accepts a hand-written file with no version field (defaults to OCC version 0)', async () => {
      const canopyDir = testRoot
      await fs.mkdir(canopyDir, { recursive: true })
      await fs.writeFile(
        path.join(canopyDir, 'permissions.json'),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin',
          pathPermissions: [{ path: 'content/admin/**', edit: {} }],
        }),
        'utf-8',
      )

      const permissions = await loadPathPermissions(testRoot, 'prod')
      expect(permissions).toHaveLength(1)
    })
  })

  describe('mutatePermissionsFile', () => {
    it('saves permissions to file', async () => {
      const permissions = [
        {
          path: unsafeAsPermissionPath('content/admin/**'),
          edit: {},
        },
        {
          path: unsafeAsPermissionPath('content/users/**'),
          edit: { allowedUsers: ['user-1', 'user-2'] },
        },
      ]

      await mutatePermissionsFile(testRoot, 'prod', () => ({
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin-user',
        pathPermissions: permissions,
      }))

      const filePath = path.join(testRoot, 'permissions.json')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.version).toBe(1)
      expect(parsed.writeId).toEqual(expect.any(String))
      expect(parsed.updatedBy).toBe('admin-user')
      expect(parsed.updatedAt).toBeTruthy()
      expect(parsed.pathPermissions).toHaveLength(2)
      expect(parsed.pathPermissions[0]).toEqual({
        path: 'content/admin/**',
        edit: {},
      })
    })

    it('validates the mutator payload before writing', async () => {
      await expect(
        mutatePermissionsFile(testRoot, 'prod', () => ({
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin',
          pathPermissions: [{ path: '', edit: {} }], // Invalid empty path
        })),
      ).rejects.toThrow()

      // Nothing was written on validation failure.
      await expect(fs.access(path.join(testRoot, 'permissions.json'))).rejects.toThrow()
    })

    it('overwrites the previous permissions on each mutate', async () => {
      await mutatePermissionsFile(testRoot, 'prod', () => ({
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin-1',
        pathPermissions: [
          {
            path: unsafeAsPermissionPath('content/first/**'),
            edit: { allowedUsers: ['user-1'] },
          },
        ],
      }))

      await mutatePermissionsFile(testRoot, 'prod', () => ({
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin-2',
        pathPermissions: [
          {
            path: unsafeAsPermissionPath('content/second/**'),
            edit: { allowedUsers: ['user-2'] },
          },
        ],
      }))

      const loaded = await loadPathPermissions(testRoot, 'prod')

      expect(loaded).toHaveLength(1)
      expect(loaded[0].path).toBe('content/second/**')
    })

    it('passes the current file and version through to the mutator', async () => {
      await mutatePermissionsFile(testRoot, 'prod', () => ({
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin-1',
        pathPermissions: [],
      }))

      let observedVersion: number | undefined
      let observedCurrentIsNull: boolean | undefined
      await mutatePermissionsFile(testRoot, 'prod', (current, version) => {
        observedVersion = version
        observedCurrentIsNull = current === null
        return {
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin-2',
          pathPermissions: [],
        }
      })

      expect(observedCurrentIsNull).toBe(false)
      expect(observedVersion).toBe(1)
    })
  })

  describe('ensurePermissionsFile', () => {
    it('creates default file if it does not exist', async () => {
      await ensurePermissionsFile(testRoot, 'admin-user', 'prod')

      const filePath = path.join(testRoot, 'permissions.json')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.version).toBe(1)
      expect(parsed.updatedBy).toBe('admin-user')
      expect(parsed.pathPermissions).toEqual([])
    })

    it('does nothing if file already exists', async () => {
      await mutatePermissionsFile(testRoot, 'prod', () => ({
        updatedAt: new Date().toISOString(),
        updatedBy: 'original-admin',
        pathPermissions: [
          {
            path: unsafeAsPermissionPath('content/**'),
            edit: { allowedUsers: ['existing'] },
          },
        ],
      }))

      await ensurePermissionsFile(testRoot, 'new-admin', 'prod')

      const loaded = await loadPathPermissions(testRoot, 'prod')

      // Original permissions should still be there
      expect(loaded).toHaveLength(1)
      expect(loaded[0].path).toBe('content/**')

      // And the file was not rewritten (still at version 1 — ensurePermissionsFile's
      // mutator returned null, a no-op).
      const filePath = path.join(testRoot, 'permissions.json')
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(parsed.version).toBe(1)
    })
  })
})
