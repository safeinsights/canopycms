import { describe, expect, it, vi } from 'vitest'

// Mock next/server before any imports
vi.mock('next/server', () => {
  return {
    NextResponse: {
      json: (body: any, init?: any) => ({
        body,
        status: init?.status ?? 200,
        headers: init?.headers,
      }),
    },
  }
})

// Mock canopycms/http to return a controlled response
vi.mock('canopycms/http', async () => {
  return {
    createCanopyRequestHandler: vi.fn(() => {
      return async (req: any, segments: string[]) => {
        // Return different responses based on segments
        if (segments.length === 1 && segments[0] === 'branches') {
          return {
            status: 200,
            body: { ok: true, status: 200, data: { branches: [] } },
          }
        }
        if (segments.length === 0 || segments.includes('unknown')) {
          return {
            status: 404,
            body: { ok: false, status: 404, error: 'Not found' },
          }
        }
        return {
          status: 200,
          body: { ok: true, status: 200 },
        }
      }
    }),
  }
})

import { createCanopyCatchAllHandler } from './adapter'
import { createMockAuthPlugin } from './test-utils'

describe('Next.js adapter', () => {
  const mockAuthPlugin = createMockAuthPlugin({
    userId: 'test-user',
    groups: ['Admins'],
  })

  describe('createCanopyCatchAllHandler', () => {
    it('converts NextRequest to CanopyRequest and returns NextResponse', async () => {
      const handler = createCanopyCatchAllHandler({
        services: {} as any,
        authPlugin: mockAuthPlugin,
      })

      const mockNextRequest = {
        method: 'GET',
        url: 'http://localhost:3000/api/canopycms/branches',
        headers: { get: () => null },
        json: async () => undefined,
      } as any

      const response: any = await handler(mockNextRequest, {
        params: { canopycms: ['branches'] },
      })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('ok', true)
    })

    it('handles Next.js 14 direct params object', async () => {
      const handler = createCanopyCatchAllHandler({
        services: {} as any,
        authPlugin: mockAuthPlugin,
      })

      const mockNextRequest = {
        method: 'GET',
        url: 'http://localhost:3000/api/canopycms/branches',
        headers: { get: () => null },
        json: async () => undefined,
      } as any

      // Next.js 14 style - params is a direct object
      const response: any = await handler(mockNextRequest, {
        params: { canopycms: ['branches'] },
      })

      expect(response.status).toBe(200)
    })

    it('handles Next.js 15 async params Promise', async () => {
      const handler = createCanopyCatchAllHandler({
        services: {} as any,
        authPlugin: mockAuthPlugin,
      })

      const mockNextRequest = {
        method: 'GET',
        url: 'http://localhost:3000/api/canopycms/branches',
        headers: { get: () => null },
        json: async () => undefined,
      } as any

      // Next.js 15 style - params is a Promise
      const response: any = await handler(mockNextRequest, {
        params: Promise.resolve({ canopycms: ['branches'] }),
      })

      expect(response.status).toBe(200)
    })

    it('handles missing params gracefully', async () => {
      const handler = createCanopyCatchAllHandler({
        services: {} as any,
        authPlugin: mockAuthPlugin,
      })

      const mockNextRequest = {
        method: 'GET',
        url: 'http://localhost:3000/api/canopycms',
        headers: { get: () => null },
        json: async () => undefined,
      } as any

      // No params at all
      const response: any = await handler(mockNextRequest, undefined)

      expect(response.status).toBe(404)
    })
  })
})

describe('wrapNextRequest', () => {
  it('wraps NextRequest correctly', async () => {
    const { wrapNextRequest } = await import('./adapter')

    const mockReq = {
      method: 'POST',
      url: 'http://localhost:3000/api/canopycms/branches',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'authorization' ? 'Bearer test-token' : null,
      },
      json: async () => ({ name: 'test-branch' }),
    } as any

    const wrapped = wrapNextRequest(mockReq)

    expect(wrapped.method).toBe('POST')
    expect(wrapped.url).toBe('http://localhost:3000/api/canopycms/branches')
    expect(wrapped.header('Authorization')).toBe('Bearer test-token')
    expect(await wrapped.json()).toEqual({ name: 'test-branch' })
  })

  it('returns null for missing headers', async () => {
    const { wrapNextRequest } = await import('./adapter')

    const mockReq = {
      method: 'GET',
      url: 'http://localhost:3000/api/test',
      headers: {
        get: () => null,
      },
      json: async () => undefined,
    } as any

    const wrapped = wrapNextRequest(mockReq)

    expect(wrapped.header('X-Custom-Header')).toBeNull()
  })

  it('returns undefined for GET request body', async () => {
    const { wrapNextRequest } = await import('./adapter')

    const mockReq = {
      method: 'GET',
      url: 'http://localhost:3000/api/test',
      headers: {
        get: () => null,
      },
      json: async () => {
        throw new Error('No body')
      },
    } as any

    const wrapped = wrapNextRequest(mockReq)

    expect(await wrapped.json()).toBeUndefined()
  })
})
