import { describe, it, expect, vi } from 'vitest'

import { executeGuards } from './guards'
import type { GuardId } from './guards'
import { createMockApiContext, createMockBranchContext, createMockUser } from '../test-utils'
import type { FlatSchemaItem } from '../config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal flatSchema for tests requiring schema guard */
const fakeFlatSchema: FlatSchemaItem[] = [
  {
    type: 'collection',
    name: 'posts',
    logicalPath: 'content/posts' as any,
    entries: [{ name: 'post', format: 'json' as const, schema: [] }],
  },
]

function makeReq(role: 'admin' | 'reviewer' | 'user' = 'user') {
  return { user: createMockUser(role) }
}

// ---------------------------------------------------------------------------
// executeGuards
// ---------------------------------------------------------------------------

describe('executeGuards', () => {
  // ========================================================================
  // Empty guard list
  // ========================================================================

  it('returns empty guard context when no guards are specified', async () => {
    const ctx = createMockApiContext()
    const result = await executeGuards([] as unknown as GuardId[], ctx, makeReq(), {})

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.guardContext).toEqual({})
    }
  })

  // ========================================================================
  // Branch guard
  // ========================================================================

  describe('branch guard', () => {
    it('returns branchContext on success', async () => {
      const bc = createMockBranchContext({ branchName: 'feature/x' })
      const ctx = createMockApiContext({ branchContext: bc })

      const result = await executeGuards(['branch'] as const, ctx, makeReq(), {
        branch: 'feature/x',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.guardContext.branchContext).toBe(bc)
      }
    })

    it('returns 404 when branch not found', async () => {
      const ctx = createMockApiContext({ branchContext: null })

      const result = await executeGuards(['branch'] as const, ctx, makeReq(), {
        branch: 'nonexistent',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(404)
        expect(result.response.error).toBe('Branch not found')
      }
    })

    it('returns 400 when branch param is missing', async () => {
      const ctx = createMockApiContext()

      const result = await executeGuards(['branch'] as const, ctx, makeReq(), {})

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(400)
        expect(result.response.error).toBe('Branch parameter required')
      }
    })

    it('returns 400 when branch param is empty string', async () => {
      const ctx = createMockApiContext()

      const result = await executeGuards(['branch'] as const, ctx, makeReq(), { branch: '' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(400)
      }
    })
  })

  // ========================================================================
  // BranchAccess guard
  // ========================================================================

  describe('branchAccess guard', () => {
    it('returns branchContext when access is allowed', async () => {
      const bc = createMockBranchContext({ branchName: 'feature/y' })
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: true,
      })

      const result = await executeGuards(['branchAccess'] as const, ctx, makeReq(), {
        branch: 'feature/y',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.guardContext.branchContext).toBe(bc)
      }
    })

    it('returns 403 when access is denied', async () => {
      const bc = createMockBranchContext({ branchName: 'restricted' })
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: false,
      })

      const result = await executeGuards(['branchAccess'] as const, ctx, makeReq(), {
        branch: 'restricted',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
      }
    })

    it('returns 404 when branch not found', async () => {
      const ctx = createMockApiContext({ branchContext: null })

      const result = await executeGuards(['branchAccess'] as const, ctx, makeReq(), {
        branch: 'gone',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(404)
        expect(result.response.error).toBe('Branch not found')
      }
    })
  })

  // ========================================================================
  // Schema guard
  // ========================================================================

  describe('schema guard', () => {
    it('returns branchContext with flatSchema on success', async () => {
      const bc = { ...createMockBranchContext(), flatSchema: fakeFlatSchema }
      const ctx = createMockApiContext({ branchContext: bc })

      const result = await executeGuards(['schema'] as const, ctx, makeReq(), { branch: 'main' })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.guardContext.branchContext.flatSchema).toBe(fakeFlatSchema)
      }
    })

    it('returns 500 when flatSchema is missing', async () => {
      // Branch exists but flatSchema was not loaded
      const bc = createMockBranchContext()
      const ctx = createMockApiContext({ branchContext: bc })

      const result = await executeGuards(['schema'] as const, ctx, makeReq(), { branch: 'main' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(500)
        expect(result.response.error).toBe('Schema not loaded for branch')
      }
    })

    it('returns 404 when branch not found', async () => {
      const ctx = createMockApiContext({ branchContext: null })

      const result = await executeGuards(['schema'] as const, ctx, makeReq(), { branch: 'missing' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(404)
      }
    })
  })

  // ========================================================================
  // BranchAccessWithSchema guard
  // ========================================================================

  describe('branchAccessWithSchema guard', () => {
    it('returns branchContext with flatSchema when access is allowed', async () => {
      const bc = { ...createMockBranchContext(), flatSchema: fakeFlatSchema }
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: true,
      })

      const result = await executeGuards(['branchAccessWithSchema'] as const, ctx, makeReq(), {
        branch: 'main',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.guardContext.branchContext.flatSchema).toBe(fakeFlatSchema)
      }
    })

    it('returns 403 when access is denied', async () => {
      const bc = { ...createMockBranchContext(), flatSchema: fakeFlatSchema }
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: false,
      })

      const result = await executeGuards(['branchAccessWithSchema'] as const, ctx, makeReq(), {
        branch: 'main',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
      }
    })

    it('returns 500 when flatSchema is missing despite access being allowed', async () => {
      const bc = createMockBranchContext() // no flatSchema
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: true,
      })

      const result = await executeGuards(['branchAccessWithSchema'] as const, ctx, makeReq(), {
        branch: 'main',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(500)
        expect(result.response.error).toBe('Schema not loaded for branch')
      }
    })

    it('returns 404 when branch not found', async () => {
      const ctx = createMockApiContext({ branchContext: null })

      const result = await executeGuards(['branchAccessWithSchema'] as const, ctx, makeReq(), {
        branch: 'nope',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(404)
      }
    })
  })

  // ========================================================================
  // Role guards: admin, reviewer, privileged
  // ========================================================================

  describe('admin guard', () => {
    it('passes for admin users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['admin'] as const, ctx, makeReq('admin'), {})

      expect(result.ok).toBe(true)
    })

    it('returns 403 for reviewer users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['admin'] as const, ctx, makeReq('reviewer'), {})

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
        expect(result.response.error).toBe('Admin access required')
      }
    })

    it('returns 403 for regular users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['admin'] as const, ctx, makeReq('user'), {})

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
        expect(result.response.error).toBe('Admin access required')
      }
    })
  })

  describe('reviewer guard', () => {
    it('passes for admin users (admins can do everything)', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['reviewer'] as const, ctx, makeReq('admin'), {})

      expect(result.ok).toBe(true)
    })

    it('passes for reviewer users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['reviewer'] as const, ctx, makeReq('reviewer'), {})

      expect(result.ok).toBe(true)
    })

    it('returns 403 for regular users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['reviewer'] as const, ctx, makeReq('user'), {})

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
        expect(result.response.error).toBe('Reviewer access required')
      }
    })
  })

  describe('privileged guard', () => {
    it('passes for admin users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['privileged'] as const, ctx, makeReq('admin'), {})

      expect(result.ok).toBe(true)
    })

    it('passes for reviewer users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['privileged'] as const, ctx, makeReq('reviewer'), {})

      expect(result.ok).toBe(true)
    })

    it('returns 403 for regular users', async () => {
      const ctx = createMockApiContext()
      const result = await executeGuards(['privileged'] as const, ctx, makeReq('user'), {})

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
        expect(result.response.error).toBe('Privileged access required')
      }
    })
  })

  // ========================================================================
  // Guard chaining
  // ========================================================================

  describe('guard chaining', () => {
    it('short-circuits on first failing guard', async () => {
      const ctx = createMockApiContext()
      const getBranchContext = ctx.getBranchContext as ReturnType<typeof vi.fn>

      // admin guard runs first, fails => branch guard never runs
      const result = await executeGuards(['admin', 'branch'] as const, ctx, makeReq('user'), {
        branch: 'main',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
        expect(result.response.error).toBe('Admin access required')
      }

      // getBranchContext should never have been called
      expect(getBranchContext).not.toHaveBeenCalled()
    })

    it('runs all guards when all pass', async () => {
      const bc = { ...createMockBranchContext(), flatSchema: fakeFlatSchema }
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: true,
      })

      const result = await executeGuards(
        ['admin', 'branchAccess'] as const,
        ctx,
        makeReq('admin'),
        { branch: 'main' },
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.guardContext.branchContext).toBe(bc)
      }
    })

    it('combines admin + branchAccess guards correctly', async () => {
      const bc = createMockBranchContext()
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: true,
      })

      // Admin + branchAccess: admin passes, branchAccess passes
      const result = await executeGuards(
        ['admin', 'branchAccess'] as const,
        ctx,
        makeReq('admin'),
        { branch: 'main' },
      )
      expect(result.ok).toBe(true)
    })

    it('fails combined guards when second guard fails', async () => {
      const bc = createMockBranchContext()
      const ctx = createMockApiContext({
        branchContext: bc,
        allowBranchAccess: false,
      })

      // Admin passes, but branchAccess denies
      const result = await executeGuards(
        ['admin', 'branchAccess'] as const,
        ctx,
        makeReq('admin'),
        { branch: 'main' },
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.response.status).toBe(403)
      }
    })

    it('combines privileged + schema guards correctly', async () => {
      const bc = { ...createMockBranchContext(), flatSchema: fakeFlatSchema }
      const ctx = createMockApiContext({ branchContext: bc })

      const result = await executeGuards(
        ['privileged', 'schema'] as const,
        ctx,
        makeReq('reviewer'),
        { branch: 'main' },
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.guardContext.branchContext.flatSchema).toBe(fakeFlatSchema)
      }
    })
  })
})
