import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CanopyApiClient, createApiClient } from './client'

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

  describe('URL encoding', () => {
    it('should encode collection and slug with spaces', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.content.read({ branch: 'main', collection: 'my collection', slug: 'my slug' })

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
      await client.content.read({ branch: 'main', collection: 'コンテンツ', slug: '文書' })

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
        collection: 'col/lection?test',
        slug: 'slug&special',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/main/content/col%2Flection%3Ftest/slug%26special',
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

    it('should handle non-JSON response body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('Unexpected token in JSON')
        },
      })

      const client = new CanopyApiClient({ fetch: mockFetch })

      await expect(client.branches.list()).rejects.toThrow('Unexpected token in JSON')
    })

    it('should handle malformed JSON gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
      })

      const client = new CanopyApiClient({ fetch: mockFetch })

      await expect(client.branches.list()).rejects.toThrow('Unexpected end of JSON input')
    })

    it('should handle empty response body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => null,
      })

      const client = new CanopyApiClient({ fetch: mockFetch })
      const result = await client.branches.list()

      // Null response returned as-is (handlers should always return ApiResponse)
      expect(result).toBeNull()
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
      await client.branches.create({ name: 'test-branch' })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/canopycms/branches',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'test-branch' }),
        }),
      )
    })

    it('should send PUT requests with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.content.write(
        { branch: 'main', collection: 'posts', slug: 'hello' },
        {
          collection: 'posts',
          format: 'json',
          data: { title: 'Hello' },
        },
      )

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })

    it('should send PATCH requests with JSON body', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      await client.branches.updateAccess({ branch: 'test-branch' }, { access: 'private' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
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

    it('should send FormData without Content-Type header', async () => {
      const client = new CanopyApiClient({ fetch: mockFetch })
      const formData = new FormData()
      formData.append('file', new Blob(['test']))

      await client.assets.upload(formData)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: formData,
          headers: {}, // No Content-Type - browser sets it with boundary
        }),
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
