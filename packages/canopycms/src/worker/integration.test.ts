import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { enqueueTask, dequeueTask, completeTask, failTask, getTaskResult } from './task-queue'
import { FileBasedAuthCache } from '../auth/file-based-auth-cache'
import { CachingAuthPlugin } from '../auth/caching-auth-plugin'
import type { TokenVerifier } from '../auth/caching-auth-plugin'

describe('Worker integration: task queue + auth cache', () => {
  let tmpDir: string
  let taskDir: string
  let cachePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-integration-test-'))
    taskDir = path.join(tmpDir, '.tasks')
    cachePath = path.join(tmpDir, '.cache')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('submit → enqueue → worker dequeue → complete', () => {
    it('full task lifecycle: enqueue PR task, worker picks up and completes', async () => {
      // 1. Lambda enqueues a PR creation task (simulates submitBranchForMergeHandler)
      const taskId = await enqueueTask(taskDir, {
        action: 'push-and-create-pr',
        payload: {
          branch: 'feature/new-page',
          title: 'Add new page',
          body: 'This adds a new documentation page',
          baseBranch: 'main',
        },
      })

      // Verify task is pending
      const pending = await getTaskResult(taskDir, taskId)
      expect(pending?.status).toBe('pending')
      expect(pending?.action).toBe('push-and-create-pr')

      // 2. Worker dequeues the task
      const task = await dequeueTask(taskDir)
      expect(task).not.toBeNull()
      expect(task!.id).toBe(taskId)
      expect(task!.action).toBe('push-and-create-pr')
      expect(task!.payload.branch).toBe('feature/new-page')

      // Verify task is now processing
      const processing = await getTaskResult(taskDir, taskId)
      expect(processing?.status).toBe('processing')

      // 3. Worker completes the task (simulates successful PR creation)
      await completeTask(taskDir, taskId, {
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
      })

      // Verify task is completed with result
      const completed = await getTaskResult(taskDir, taskId)
      expect(completed?.status).toBe('completed')
      expect(completed?.result?.prUrl).toBe('https://github.com/org/repo/pull/42')
      expect(completed?.result?.prNumber).toBe(42)

      // 4. Queue should be empty now
      const next = await dequeueTask(taskDir)
      expect(next).toBeNull()
    })

    it('worker handles task failure gracefully', async () => {
      const taskId = await enqueueTask(taskDir, {
        action: 'push-branch',
        payload: { branch: 'broken-branch' },
      })

      const task = await dequeueTask(taskDir)
      expect(task).not.toBeNull()

      // Worker fails the task
      await failTask(taskDir, taskId, 'remote rejected push: branch does not exist')

      const result = await getTaskResult(taskDir, taskId)
      expect(result?.status).toBe('failed')
      expect(result?.error).toContain('remote rejected push')
    })

    it('multiple tasks are processed in FIFO order', async () => {
      const id1 = await enqueueTask(taskDir, {
        action: 'push-and-create-pr',
        payload: { branch: 'first', title: 'First PR' },
      })

      // Small delay to ensure different createdAt timestamps
      await new Promise((r) => setTimeout(r, 10))

      const id2 = await enqueueTask(taskDir, {
        action: 'push-and-create-pr',
        payload: { branch: 'second', title: 'Second PR' },
      })

      // First dequeue should return first task
      const task1 = await dequeueTask(taskDir)
      expect(task1!.id).toBe(id1)
      await completeTask(taskDir, id1, { prNumber: 1 })

      // Second dequeue should return second task
      const task2 = await dequeueTask(taskDir)
      expect(task2!.id).toBe(id2)
      await completeTask(taskDir, id2, { prNumber: 2 })

      // Queue empty
      expect(await dequeueTask(taskDir)).toBeNull()
    })
  })

  describe('auth cache: write → read via CachingAuthPlugin', () => {
    it('CachingAuthPlugin reads from file cache populated by worker', async () => {
      // 1. Simulate worker writing auth cache (like refreshDevCache or refreshClerkCache)
      await fs.mkdir(cachePath, { recursive: true })
      await fs.writeFile(
        path.join(cachePath, 'users.json'),
        JSON.stringify({
          users: [
            {
              id: 'user_1',
              name: 'Alice',
              email: 'alice@test.com',
              avatarUrl: 'https://avatar/alice',
            },
            { id: 'user_2', name: 'Bob', email: 'bob@test.com' },
          ],
        }),
      )
      await fs.writeFile(
        path.join(cachePath, 'orgs.json'),
        JSON.stringify({
          groups: [{ id: 'org_1', name: 'Engineering', memberCount: 5 }],
        }),
      )
      await fs.writeFile(
        path.join(cachePath, 'memberships.json'),
        JSON.stringify({
          memberships: {
            user_1: ['org_1'],
            user_2: [],
          },
        }),
      )

      // 2. Create CachingAuthPlugin with a mock token verifier
      const mockVerifier: TokenVerifier = async () => ({ userId: 'user_1' })
      const cache = new FileBasedAuthCache(cachePath)
      const plugin = new CachingAuthPlugin(mockVerifier, cache)

      // 3. Authenticate — should read from file cache
      const authResult = await plugin.authenticate({})
      expect(authResult.success).toBe(true)
      expect(authResult.user?.userId).toBe('user_1')
      expect(authResult.user?.name).toBe('Alice')
      expect(authResult.user?.email).toBe('alice@test.com')
      expect(authResult.user?.externalGroups).toEqual(['org_1'])

      // 4. Other metadata operations work from cache
      const user = await plugin.getUserMetadata('user_2')
      expect(user?.name).toBe('Bob')

      const groups = await plugin.listGroups()
      expect(groups).toHaveLength(1)
      expect(groups[0].name).toBe('Engineering')

      const searchResults = await plugin.searchUsers('alice')
      expect(searchResults).toHaveLength(1)
      expect(searchResults[0].name).toBe('Alice')
    })

    it('CachingAuthPlugin handles missing cache gracefully', async () => {
      // No cache files written — simulates first run before worker has run
      const mockVerifier: TokenVerifier = async () => ({ userId: 'new_user' })
      const cache = new FileBasedAuthCache(cachePath)
      const plugin = new CachingAuthPlugin(mockVerifier, cache)

      // Should still authenticate, but with minimal metadata
      const authResult = await plugin.authenticate({})
      expect(authResult.success).toBe(true)
      expect(authResult.user?.userId).toBe('new_user')
      expect(authResult.user?.name).toBe('new_user') // Falls back to userId
      expect(authResult.user?.externalGroups).toEqual([])
    })

    it('cache updates are picked up on next read', async () => {
      const mockVerifier: TokenVerifier = async () => ({ userId: 'user_1' })
      const cache = new FileBasedAuthCache(cachePath)
      const plugin = new CachingAuthPlugin(mockVerifier, cache)

      // Initial: no cache
      const result1 = await plugin.authenticate({})
      expect(result1.user?.name).toBe('user_1') // fallback

      // Worker writes cache
      await fs.mkdir(cachePath, { recursive: true })
      // Small delay so mtime differs
      await new Promise((r) => setTimeout(r, 50))
      await fs.writeFile(
        path.join(cachePath, 'users.json'),
        JSON.stringify({
          users: [{ id: 'user_1', name: 'Alice Updated', email: 'alice@test.com' }],
        }),
      )
      await fs.writeFile(path.join(cachePath, 'orgs.json'), JSON.stringify({ groups: [] }))
      await fs.writeFile(
        path.join(cachePath, 'memberships.json'),
        JSON.stringify({ memberships: {} }),
      )

      // Should pick up new data
      const result2 = await plugin.authenticate({})
      expect(result2.user?.name).toBe('Alice Updated')
    })
  })

  describe('end-to-end: task queue + auth cache together', () => {
    it('simulates full prod-sim workflow', async () => {
      // 1. Worker initializes auth cache (like run-once)
      await fs.mkdir(cachePath, { recursive: true })
      await fs.writeFile(
        path.join(cachePath, 'users.json'),
        JSON.stringify({
          users: [
            {
              id: 'dev_user1_2nK8mP4xL9',
              name: 'User One',
              email: 'user1@localhost.dev',
            },
          ],
        }),
      )
      await fs.writeFile(
        path.join(cachePath, 'orgs.json'),
        JSON.stringify({
          groups: [{ id: 'team-a', name: 'Team A' }],
        }),
      )
      await fs.writeFile(
        path.join(cachePath, 'memberships.json'),
        JSON.stringify({
          memberships: { dev_user1_2nK8mP4xL9: ['team-a'] },
        }),
      )

      // 2. Lambda authenticates user via CachingAuthPlugin
      const devVerifier: TokenVerifier = async () => ({
        userId: 'dev_user1_2nK8mP4xL9',
      })
      const plugin = new CachingAuthPlugin(devVerifier, new FileBasedAuthCache(cachePath))
      const auth = await plugin.authenticate({})
      expect(auth.success).toBe(true)
      expect(auth.user?.name).toBe('User One')
      expect(auth.user?.externalGroups).toEqual(['team-a'])

      // 3. Lambda enqueues a PR task (no githubService available)
      const taskId = await enqueueTask(taskDir, {
        action: 'push-and-create-pr',
        payload: {
          branch: 'feature/edit-page',
          title: 'Edit home page',
          body: 'Updated hero section',
          baseBranch: 'main',
        },
      })

      // 4. Worker picks up and processes the task
      const task = await dequeueTask(taskDir)
      expect(task!.action).toBe('push-and-create-pr')
      expect(task!.payload.branch).toBe('feature/edit-page')

      // Simulate worker executing the task (push + create PR)
      await completeTask(taskDir, taskId, {
        prUrl: 'https://github.com/org/repo/pull/7',
        prNumber: 7,
      })

      // 5. Verify final state
      const result = await getTaskResult(taskDir, taskId)
      expect(result?.status).toBe('completed')
      expect(result?.result?.prNumber).toBe(7)
    })
  })
})
