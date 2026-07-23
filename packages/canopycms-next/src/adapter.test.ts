import { describe, expect, it, vi } from 'vitest'

// Mock next/server before any imports.
// NextResponse must be both a constructor (adapter.ts does
// `new NextResponse(body, init)` for binary responses) and expose the
// static `.json()` factory (used for the JSON response path).
vi.mock('next/server', () => {
  class MockNextResponse {
    body: any
    status: number
    headers: any
    constructor(body?: any, init?: any) {
      this.body = body
      this.status = init?.status ?? 200
      this.headers = init?.headers
    }
    static json(body: any, init?: any) {
      return { body, status: init?.status ?? 200, headers: init?.headers }
    }
  }
  return { NextResponse: MockNextResponse }
})

// Mock canopycms/http's createCanopyRequestHandler to return a controlled
// response, but keep every other real export (isCanopyBinaryResponse,
// jsonResponse, etc.) - adapter.ts's toNextResponse() calls
// isCanopyBinaryResponse() on every response, so a full-module mock without
// it would break at runtime for every test in this file, binary or not.
vi.mock('canopycms/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('canopycms/http')>()
  return {
    ...actual,
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

    it('returns a sanitized 500 envelope instead of throwing when coreHandler rejects (API-C1)', async () => {
      const { createCanopyRequestHandler } = await import('canopycms/http')
      vi.mocked(createCanopyRequestHandler).mockReturnValueOnce(async () => {
        throw new Error(
          `clone failed for /mnt/efs/workspace/main from ` +
            `https://x-access-token:ghp_secret789@github.com/org/repo.git`,
        )
      })

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

      const response: any = await handler(mockNextRequest, { params: { canopycms: ['branches'] } })

      expect(response.status).toBe(500)
      expect(response.body).toHaveProperty('ok', false)
      const error = response.body.error ?? ''
      expect(error).not.toContain('ghp_secret789')
      expect(error).not.toContain('/mnt/efs')
      expect(error).toContain('***@github.com')
      expect(error).toContain('<path>')
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

describe('binary responses (M2 plumbing)', () => {
  const mockAuthPlugin = createMockAuthPlugin({
    userId: 'test-user',
    groups: ['Admins'],
  })

  const mockGetRequest = (segments: string[]) =>
    ({
      method: 'GET',
      url: `http://localhost:3000/api/canopycms/${segments.join('/')}`,
      headers: { get: () => null },
      json: async () => undefined,
    }) as any

  it('converts a Uint8Array CanopyBinaryResponse to NextResponse bytes + headers', async () => {
    const { createCanopyRequestHandler } = await import('canopycms/http')
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.mocked(createCanopyRequestHandler).mockReturnValueOnce(async () => ({
      kind: 'binary',
      status: 200,
      body: bytes,
      headers: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=60',
        etag: '"abc123"',
      },
    }))

    const handler = createCanopyCatchAllHandler({ services: {} as any, authPlugin: mockAuthPlugin })
    const response: any = await handler(mockGetRequest(['assets', 'hash', 'file.png']), {
      params: { canopycms: ['assets', 'hash', 'file.png'] },
    })

    expect(response.status).toBe(200)
    // toEqual (not toBe): adapter.ts copies the Uint8Array through a fresh
    // ArrayBuffer-backed view to satisfy the DOM lib's BodyInit typing -
    // same bytes, different reference.
    expect(response.body).toEqual(bytes)
    expect(response.headers).toEqual({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=60',
      ETag: '"abc123"',
    })
  })

  it('streams a ReadableStream CanopyBinaryResponse through end-to-end', async () => {
    const { createCanopyRequestHandler } = await import('canopycms/http')
    const chunk = new Uint8Array([9, 8, 7])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.close()
      },
    })
    vi.mocked(createCanopyRequestHandler).mockReturnValueOnce(async () => ({
      kind: 'binary',
      status: 200,
      body: stream,
      headers: { contentType: 'application/pdf' },
    }))

    const handler = createCanopyCatchAllHandler({ services: {} as any, authPlugin: mockAuthPlugin })
    const response: any = await handler(mockGetRequest(['assets', 'hash', 'doc.pdf']), {
      params: { canopycms: ['assets', 'hash', 'doc.pdf'] },
    })

    expect(response.status).toBe(200)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value).toEqual(chunk)
  })

  it('omits headers that were not set on the CanopyBinaryResponse (e.g. no contentDisposition)', async () => {
    const { createCanopyRequestHandler } = await import('canopycms/http')
    vi.mocked(createCanopyRequestHandler).mockReturnValueOnce(async () => ({
      kind: 'binary',
      status: 200,
      body: new Uint8Array([1]),
      headers: { contentType: 'image/svg+xml' },
    }))

    const handler = createCanopyCatchAllHandler({ services: {} as any, authPlugin: mockAuthPlugin })
    const response: any = await handler(mockGetRequest(['assets', 'hash', 'icon.svg']), {
      params: { canopycms: ['assets', 'hash', 'icon.svg'] },
    })

    expect(response.headers).toEqual({ 'Content-Type': 'image/svg+xml' })
    expect(response.headers).not.toHaveProperty('Content-Disposition')
  })

  it('leaves the JSON response path unaffected (regression)', async () => {
    const handler = createCanopyCatchAllHandler({ services: {} as any, authPlugin: mockAuthPlugin })
    const response: any = await handler(mockGetRequest(['branches']), {
      params: { canopycms: ['branches'] },
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, status: 200, data: { branches: [] } })
  })
})

describe('wrapNextRequest - raw body / formData capabilities (M2 plumbing)', () => {
  it('round-trips rawBody() to the exact bytes of a real Request body', async () => {
    const { wrapNextRequest } = await import('./adapter')

    const payload = new TextEncoder().encode('hello binary world')
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      body: payload,
    })

    const wrapped = wrapNextRequest(req)
    const bytes = await wrapped.rawBody?.()

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toEqual(payload)
  })

  it('round-trips formData() from a real multipart/form-data Request', async () => {
    const { wrapNextRequest } = await import('./adapter')

    const formData = new FormData()
    formData.append('field', 'value')
    formData.append(
      'file',
      new File([new Uint8Array([1, 2, 3])], 'test.bin', { type: 'application/octet-stream' }),
    )
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      body: formData,
    })

    const wrapped = wrapNextRequest(req)
    const parsed = await wrapped.formData?.()

    expect(parsed?.get('field')).toBe('value')
    const file = parsed?.get('file') as File
    expect(file.name).toBe('test.bin')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
