import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'
import { USER_ROUTES } from './user'

// Extract handler for testing
const getUserInfo = USER_ROUTES.whoami.handler

describe('user API', () => {
  let mockContext: ApiContext

  beforeEach(() => {
    mockContext = {
      services: {
        config: {
          defaultBaseBranch: 'main',
          mode: 'local-simple',
        },
        checkBranchAccess: vi.fn(),
        checkContentAccess: vi.fn(),
        bootstrapAdminIds: new Set<string>(),
        registry: undefined as any,
      },
      getBranchContext: vi.fn(),
    } as unknown as ApiContext
  })

  describe('whoami', () => {
    it('should return user info for authenticated user without groups', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'user-1' as CanopyUserId,
          groups: [],
        },
      }

      const result = await getUserInfo(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data).toEqual({
        userId: 'user-1',
        groups: [],
      })
    })

    it('should return user info with multiple groups', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-user' as CanopyUserId,
          groups: ['admins' as CanopyGroupId, 'reviewers' as CanopyGroupId, 'editors' as CanopyGroupId],
        },
      }

      const result = await getUserInfo(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data).toEqual({
        userId: 'admin-user',
        groups: ['admins', 'reviewers', 'editors'],
      })
    })

    it('should return user info with single group', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'reviewer-user' as CanopyUserId,
          groups: ['reviewers' as CanopyGroupId],
        },
      }

      const result = await getUserInfo(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data).toEqual({
        userId: 'reviewer-user',
        groups: ['reviewers'],
      })
    })

    it('should preserve exact user ID from request', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'user-with-special-chars-123' as CanopyUserId,
          groups: [],
        },
      }

      const result = await getUserInfo(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.userId).toBe('user-with-special-chars-123')
    })

    it('should return response with correct response type structure', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'test-user' as CanopyUserId,
          groups: ['test-group' as CanopyGroupId],
        },
      }

      const result = await getUserInfo(mockContext, req)

      // Verify ApiResponse structure
      expect(result).toHaveProperty('ok')
      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('data')
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })
  })
})
