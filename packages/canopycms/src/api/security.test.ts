/**
 * Security tests for API endpoints.
 *
 * Verifies:
 * - Branch access checks are enforced on all endpoints that accept a branch parameter
 * - Double-encoded path traversal attempts are rejected
 * - Invalid branch names are rejected by Zod validation
 */

import { describe, it, expect, vi } from 'vitest'
import type { ApiRequest } from './types'
import type { FlatSchemaItem } from '../config'
import type { ContentId, LogicalPath } from '../paths/types'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'
import { createMockApiContext, createMockBranchContext, createMockUser } from '../test-utils'

// Mock SchemaOps for schema tests
vi.mock('../schema/schema-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schema/schema-store')>()
  return {
    ...actual,
    SchemaOps: vi.fn().mockImplementation(() => ({
      createCollection: vi.fn(),
      updateCollection: vi.fn(),
      deleteCollection: vi.fn(),
      addEntryType: vi.fn(),
      updateEntryType: vi.fn(),
      removeEntryType: vi.fn(),
      updateOrder: vi.fn(),
      isCollectionEmpty: vi.fn(),
      countEntriesUsingType: vi.fn(),
      readCollectionMeta: vi.fn(),
    })),
  }
})

// Mock ContentStore for reference tests
vi.mock('../content-store', () => ({
  ContentStore: vi.fn().mockImplementation(() => ({
    idIndex: vi.fn().mockResolvedValue({}),
    read: vi.fn().mockResolvedValue({ data: { title: 'Test' } }),
  })),
  ContentStoreError: class ContentStoreError extends Error {},
}))

// Mock ReferenceResolver
vi.mock('../reference-resolver', () => ({
  ReferenceResolver: vi.fn().mockImplementation(() => ({
    loadReferenceOptions: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue({ exists: true, collection: 'posts', slug: 'hello' }),
  })),
}))

import { REFERENCE_OPTIONS_ROUTES } from './reference-options'
import { RESOLVE_REFERENCES_ROUTES } from './resolve-references'
import { getSchema, getCollection } from './schema'

describe('Security: Branch access checks', () => {
  const mockFlatSchema: FlatSchemaItem[] = [
    {
      type: 'collection',
      logicalPath: 'posts' as LogicalPath,
      name: 'posts',
      label: 'Posts',
      contentId: 'a1b2c3d4e5f6' as ContentId,
      entries: [{ name: 'post', format: 'json', schema: [], schemaRef: 'postSchema' }],
    },
  ]

  const branchContext = createMockBranchContext({
    branchName: 'secret-branch',
  })

  describe('reference-options endpoint', () => {
    it('returns 403 when user lacks branch access', async () => {
      const ctx = createMockApiContext({
        branchContext: { ...branchContext, flatSchema: mockFlatSchema },
        allowBranchAccess: false,
      })
      const req = {
        user: createMockUser(),
        query: { collections: 'posts' },
      } as unknown as ApiRequest

      const result = await REFERENCE_OPTIONS_ROUTES.get.handler(ctx, req, {
        branch: unsafeAsBranchName('secret-branch'),
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })

    it('returns 200 when user has branch access', async () => {
      const ctx = createMockApiContext({
        branchContext: { ...branchContext, flatSchema: mockFlatSchema },
        allowBranchAccess: true,
      })
      const req = {
        user: createMockUser(),
        query: { collections: 'posts', displayField: 'title' },
      } as unknown as ApiRequest

      const result = await REFERENCE_OPTIONS_ROUTES.get.handler(ctx, req, {
        branch: unsafeAsBranchName('secret-branch'),
      })

      expect(result.ok).toBe(true)
    })
  })

  describe('resolve-references endpoint', () => {
    it('returns 403 when user lacks branch access', async () => {
      const ctx = createMockApiContext({
        branchContext: { ...branchContext, flatSchema: mockFlatSchema },
        allowBranchAccess: false,
      })
      const req = { user: createMockUser() } as unknown as ApiRequest

      const result = await RESOLVE_REFERENCES_ROUTES.post.handler(
        ctx,
        req,
        { branch: unsafeAsBranchName('secret-branch') },
        { ids: ['a1b2c3d4e5f6' as ContentId] },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })
  })

  describe('getSchema endpoint', () => {
    it('returns 403 when user lacks branch access', async () => {
      const ctx = createMockApiContext({
        branchContext: { ...branchContext, flatSchema: mockFlatSchema },
        allowBranchAccess: false,
        services: {
          entrySchemaRegistry: { postSchema: [{ name: 'title', type: 'string' }] },
        },
      })
      const req = { user: createMockUser() } as unknown as ApiRequest

      const result = await getSchema.handler(ctx, req, {
        branch: unsafeAsBranchName('secret-branch'),
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })
  })

  describe('getCollection endpoint', () => {
    it('returns 403 when user lacks branch access', async () => {
      const ctx = createMockApiContext({
        branchContext: { ...branchContext, flatSchema: mockFlatSchema },
        allowBranchAccess: false,
      })
      const req = { user: createMockUser() } as unknown as ApiRequest

      const result = await getCollection.handler(ctx, req, {
        branch: unsafeAsBranchName('secret-branch'),
        collectionPath: unsafeAsLogicalPath('posts'),
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })
  })
})

describe('Security: flatSchema null safety', () => {
  it('returns 500 when flatSchema is not loaded', async () => {
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'test' }),
      allowBranchAccess: true,
      services: {
        entrySchemaRegistry: {},
      },
    })
    // branchContext has no flatSchema property
    const req = { user: createMockUser() } as unknown as ApiRequest

    const result = await getSchema.handler(ctx, req, {
      branch: unsafeAsBranchName('test'),
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.error).toContain('Schema not loaded')
  })
})

describe('Security: Branch name validation', () => {
  it('branchNameSchema rejects traversal attempts', async () => {
    const { branchNameSchema } = await import('./validators')

    const traversalAttempts = [
      '../etc/passwd',
      'branch/../escape',
      'branch/...',
      'branch@{evil}',
      'branch name with spaces',
    ]

    for (const name of traversalAttempts) {
      const result = branchNameSchema.safeParse(name)
      expect(result.success, `Expected "${name}" to be rejected`).toBe(false)
    }
  })

  it('branchNameSchema accepts valid branch names', async () => {
    const { branchNameSchema } = await import('./validators')

    const validNames = ['main', 'feature/test', 'fix-123', 'release/v1.0']

    for (const name of validNames) {
      const result = branchNameSchema.safeParse(name)
      expect(result.success, `Expected "${name}" to be accepted`).toBe(true)
    }
  })
})

describe('Security: Double URL decoding protection', () => {
  it('logicalPathSchema rejects traversal sequences', async () => {
    const { logicalPathSchema } = await import('./validators')

    const attacks = ['../etc/passwd', 'content/../../../etc/passwd', 'content/..%2F..%2Fetc']

    for (const path of attacks) {
      const result = logicalPathSchema.safeParse(path)
      expect(result.success, `Expected "${path}" to be rejected`).toBe(false)
    }
  })
})
