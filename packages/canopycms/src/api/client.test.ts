import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CanopyApiClient, createApiClient } from './client'
import { computeContentSha256Hex } from './request-body-hash'

describe('CanopyApiClient', () => {
  describe('Response handling', () => {
    it('should return ApiResponse format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: { branches: [] } }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      const result = await client.branches.list()

      expect(result).toEqual({
        ok: true,
        status: 200,
        data: { branches: [] },
      })
    })

    it('should handle error responses with ok: false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, status: 403, error: 'Forbidden' }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      const result = await client.branches.list()

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Forbidden',
      })
    })
  })

  describe('onUnauthorized', () => {
    const respond = (status: number, json: () => Promise<unknown>) =>
      vi.fn().mockResolvedValue({ ok: status < 400, status, json })

    it('is called on a 401, and the response still reaches the caller unchanged', async () => {
      const onUnauthorized = vi.fn()
      const body = { ok: false, status: 401, error: 'Unauthorized' }
      const client = new CanopyApiClient({
        fetch: respond(401, async () => body),
        onUnauthorized,
      })

      expect(await client.branches.list()).toEqual(body)
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })

    it('is not called for other statuses, including 403', async () => {
      const onUnauthorized = vi.fn()
      for (const status of [200, 403, 500]) {
        const client = new CanopyApiClient({
          fetch: respond(status, async () => ({ ok: status < 400, status })),
          onUnauthorized,
        })
        await client.branches.list()
      }
      expect(onUnauthorized).not.toHaveBeenCalled()
    })

    it('returns a non-JSON 401 as a 401 ApiResponse instead of throwing, and reports it', async () => {
      const onUnauthorized = vi.fn()
      const client = new CanopyApiClient({
        fetch: respond(401, async () => {
          throw new SyntaxError('Unexpected token <')
        }),
        onUnauthorized,
      })

      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 401,
        error: 'Unauthorized',
      })
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })

    it('returns a JSON 401 that is not an ApiResponse as one, keeping a string error', async () => {
      const client = new CanopyApiClient({
        fetch: respond(401, async () => ({
          message: 'proxy says no',
          error: 'Forbidden by proxy',
        })),
      })
      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 401,
        error: 'Forbidden by proxy',
      })

      const bare = new CanopyApiClient({ fetch: respond(401, async () => ({ message: 'nope' })) })
      expect(await bare.branches.list()).toEqual({ ok: false, status: 401, error: 'Unauthorized' })
    })
  })

  describe('URL encoding', () => {
    it('should encode collection and slug with spaces', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.content.read({
        branch: 'main',
        path: 'my collection/my slug',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/main/content/my%20collection/my%20slug',
        expect.anything(),
      )
    })

    it('should encode Unicode characters in paths', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.content.read({ branch: 'main', path: 'コンテンツ/文書' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/main/content/%E3%82%B3%E3%83%B3%E3%83%86%E3%83%B3%E3%83%84/%E6%96%87%E6%9B%B8',
        expect.anything(),
      )
    })

    it('should encode special characters (/, ?, &) in paths', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.content.read({
        branch: 'main',
        path: 'col/lection?test/slug&special',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/main/content/col/lection%3Ftest/slug%26special',
        expect.anything(),
      )
    })

    it('should handle query params with special characters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.entries.list({ branch: 'main', q: 'search & test' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/main/entries?q=search+%26+test',
        expect.anything(),
      )
    })
  })

  describe('Error handling', () => {
    it('should handle network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const client = new CanopyApiClient({ fetch: mockFetch })

      await expect(client.branches.list()).rejects.toThrow('Network error')
    })

    it('returns an ok:false ApiResponse naming the status for a non-JSON body from a proxy', async () => {
      const htmlBody = () => Promise.reject(new SyntaxError('Unexpected token < in JSON'))
      for (const status of [403, 404]) {
        const client = new CanopyApiClient({
          fetch: vi.fn().mockResolvedValue({ ok: false, status, json: htmlBody }),
        })
        expect(await client.branches.list()).toEqual({
          ok: false,
          status,
          error: `Unexpected response from server (HTTP ${status})`,
        })
      }
    })

    it('returns an ok:false ApiResponse for an empty body', async () => {
      const client = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input')
          },
        }),
      })

      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 502,
        error: 'Unexpected response from server (HTTP 502)',
      })
    })

    it('keeps the string error of a JSON body that is not an ApiResponse', async () => {
      const client = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ error: 'upstream exploded' }),
        }),
      })

      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 500,
        error: 'upstream exploded',
      })
    })

    it('returns an ok:false ApiResponse for a 2xx whose body is not JSON', async () => {
      const client = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON')
          },
        }),
      })

      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 200,
        error: 'Unexpected response from server (HTTP 200)',
      })
    })

    it('returns an ok:false ApiResponse for a null JSON body', async () => {
      const client = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => null }),
      })

      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 200,
        error: 'Unexpected response from server (HTTP 200)',
      })
    })

    it('passes a well-formed ApiResponse through unchanged, errors included', async () => {
      const body = {
        ok: false,
        status: 422,
        error: 'Invalid',
        fieldErrors: [{ fieldPath: 'a', message: 'b' }],
      }
      const client = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => body }),
      })

      expect(await client.branches.list()).toEqual(body)
    })
  })

  describe('Configuration', () => {
    it('should use custom baseUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({
        baseUrl: '/custom/api/path',
        fetch: mockFetch,
      })

      await client.branches.list()

      expect(mockFetch).toHaveBeenCalledWith('/custom/api/path/branches', expect.anything())
    })

    it('should use custom fetch implementation', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: customFetch })
      await client.branches.list()

      expect(customFetch).toHaveBeenCalled()
    })

    it('should default to /api/canopycms baseUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.list()

      expect(mockFetch).toHaveBeenCalledWith('/api/canopycms/branches', expect.anything())
    })

    it('should handle baseUrl with trailing slash', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({
        baseUrl: '/api/canopycms/',
        fetch: mockFetch,
      })

      await client.branches.list()

      expect(mockFetch).toHaveBeenCalledWith('/api/canopycms//branches', expect.anything())
    })
  })

  describe('HTTP methods', () => {
    let mockFetch: typeof fetch

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      }) as typeof fetch
    })

    it('should send GET requests without body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.list()

      expect(mockFetch).toHaveBeenCalledWith('/api/canopycms/branches', {
        method: 'GET',
        headers: {},
      })
    })

    it('should send POST requests with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.create({ branch: 'test-branch' })

      const expectedBody = JSON.stringify({ branch: 'test-branch' })
      const expectedHash = await computeContentSha256Hex(expectedBody)

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/branches',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-amz-content-sha256': expectedHash },
          body: expectedBody,
        }),
      )
    })

    it('should send PUT requests with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.content.write(
        { branch: 'main', path: 'posts/hello' },
        {
          format: 'json',
          data: { title: 'Hello' },
        },
      )

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-amz-content-sha256': expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        }),
      )
    })

    it('should send PATCH requests with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.updateAccess({ branch: 'test-branch' }, { allowedUsers: ['user-1'] })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-amz-content-sha256': expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        }),
      )
    })

    it('should send DELETE requests without body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.delete({ branch: 'test-branch' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'DELETE',
          headers: {},
        }),
      )
    })

    it('should send asset presign with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })

      await client.assets.presign({ filename: 'test.jpg', contentType: 'image/jpeg' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-amz-content-sha256': expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        }),
      )
    })

    it('should send asset finalize with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })

      await client.assets.finalize({ stagingKey: 'asset-staging/x', filename: 'test.jpg' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/assets/finalize',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('should send asset uploadProxied as multipart/form-data, not JSON (hand-written client method)', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'test.jpg', { type: 'image/jpeg' })

      await client.assets.uploadProxied(file)

      expect(mockFetch).toHaveBeenCalledWith('/api/canopycms/assets/upload', expect.anything())
      const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ]
      expect(init.method).toBe('POST')
      expect(init.body).toBeInstanceOf(FormData)
      const formData = init.body as FormData
      expect((formData.get('file') as File).name).toBe('test.jpg')
      // Browser sets the multipart boundary Content-Type itself; a FormData
      // body must never get the JSON Content-Type or the OAC signing header
      // (see the request() body-branching in client.ts / generate-client.ts).
      expect(init.headers).not.toHaveProperty('Content-Type')
      expect(init.headers).not.toHaveProperty('x-amz-content-sha256')
    })

    it('should forward an optional filename override in uploadProxied', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      const file = new File([new Uint8Array([1])], 'original.jpg', { type: 'image/jpeg' })

      await client.assets.uploadProxied(file, { filename: 'renamed.jpg' })

      const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ]
      const formData = init.body as FormData
      expect(formData.get('filename')).toBe('renamed.jpg')
      expect((formData.get('file') as File).name).toBe('original.jpg')
    })
  })

  describe('x-amz-content-sha256 (CloudFront OAC body signing)', () => {
    it('attaches the header on a body-carrying POST request', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      const body = { branch: 'test-branch' }
      await client.branches.create(body)

      const expectedHash = await computeContentSha256Hex(JSON.stringify(body))

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-amz-content-sha256': expectedHash }),
        }),
      )
    })

    it('omits the header on a GET request with no body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: { branches: [] } }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.list()

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.headers).not.toHaveProperty('x-amz-content-sha256')
    })

    it('omits the header on a DELETE request with no body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: { deleted: true } }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.delete({ branch: 'test-branch' })

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.headers).not.toHaveProperty('x-amz-content-sha256')
    })

    it('does not attach the header for a FormData body (assets.uploadProxied)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch, baseUrl: '/api/canopycms' })
      const file = new File(['contents'], 'file.bin')

      await client.assets.uploadProxied(file)

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.headers).not.toHaveProperty('x-amz-content-sha256')
      expect(init.body).toBeInstanceOf(FormData)
    })
  })

  describe('Query parameters', () => {
    it('should build query parameters for searchUsers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: { users: [] } }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.permissions.searchUsers({ q: 'john', limit: '10' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/users/search?q=john&limit=10',
        expect.anything(),
      )
    })

    it('should forward prefix to assets.list (API-H4)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: { assets: [] } }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.assets.list({ prefix: 'images/' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/assets?prefix=images%2F',
        expect.anything(),
      )
    })

    it('should forward key to assets.delete (API-H4)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: { deleted: true } }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.assets.delete({ key: 'a.png' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/assets?key=a.png',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  describe('createApiClient factory', () => {
    it('should create a CanopyApiClient instance', () => {
      const client = createApiClient()
      expect(client).toBeInstanceOf(CanopyApiClient)
    })

    it('should forward options to constructor', () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = createApiClient({ baseUrl: '/custom', fetch: mockFetch })
      expect(client).toBeInstanceOf(CanopyApiClient)
    })
  })
})
