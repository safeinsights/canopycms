import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CanopyApiClient, createApiClient, isNonApiResponse } from './client'
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

    it('is called on a 419 whose handler body says 401, as unauthenticatedStatus sends', async () => {
      const onUnauthorized = vi.fn()
      const body = { ok: false, status: 401, error: 'Unauthorized' }
      const client = new CanopyApiClient({ fetch: respond(419, async () => body), onUnauthorized })

      expect(await client.branches.list()).toEqual(body)
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })

    it('is not called on a 403 whose body is not an ApiResponse, even one naming 401', async () => {
      const onUnauthorized = vi.fn()
      const client = new CanopyApiClient({
        fetch: respond(403, async () => ({ status: 401, error: 'from a proxy' })),
        onUnauthorized,
      })

      expect(await client.branches.list()).toMatchObject({ ok: false, status: 403 })
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

  describe('Throttled requests', () => {
    // The body a Lambda Function URL sends when its concurrency cap throttles a request.
    const throttled = (headers: Record<string, string> = {}) => ({
      ok: false,
      status: 429,
      headers: new Headers(headers),
      json: async () => ({ Message: 'Rate Exceeded.' }),
    })
    const success = { ok: true, status: 200, data: { branches: [] } }
    const succeeded = () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => success,
    })

    beforeEach(() => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0)
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('resends a throttled request after backing off, and returns the eventual response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(throttled())
        .mockResolvedValueOnce(throttled())
        .mockResolvedValueOnce(succeeded())
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()

      await vi.advanceTimersByTimeAsync(249)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      // The second wait is longer than the first.
      await vi.advanceTimersByTimeAsync(999)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(3)

      expect(await pending).toEqual(success)
    })

    it('resends a throttled write with the same body and headers', async () => {
      // Snapshot each call as sent, so a resend that mutated or emptied the request shows.
      const sent: Array<{ url: string; method?: string; headers: unknown; body: unknown }> = []
      const responses = [throttled(), succeeded()]
      const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, method: init.method, headers: { ...init.headers }, body: init.body })
        return responses.shift()
      })
      const pending = new CanopyApiClient({
        fetch: mockFetch as unknown as typeof fetch,
      }).branches.create({
        branch: 'b',
      })
      // The body hash resolves outside the fake clock, so the resend timer may not exist yet;
      // waitFor advances the clock until the resend is observed.
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      await pending

      const expectedBody = JSON.stringify({ branch: 'b' })
      const expectedHash = await computeContentSha256Hex(expectedBody)
      for (const call of sent) {
        expect(call).toEqual({
          url: '/api/canopycms/branches',
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-amz-content-sha256': expectedHash,
          }),
          body: expectedBody,
        })
      }
    })

    it('stops at once when Retry-After asks for longer than it will wait', async () => {
      const mockFetch = vi.fn().mockResolvedValue(throttled({ 'Retry-After': '60' }))
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()
      await vi.runAllTimersAsync()
      const result = await pending

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        ok: false,
        status: 429,
        error: 'Unexpected response from server (HTTP 429)',
      })
    })

    it('resends on its own delays when a custom fetch returns no headers', async () => {
      const { headers: _omitted, ...headerless } = throttled()
      const mockFetch = vi.fn().mockResolvedValueOnce(headerless).mockResolvedValueOnce(succeeded())
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()

      await vi.advanceTimersByTimeAsync(250)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(await pending).toEqual(success)
    })

    it('gives up after three resends, returning the 429 as a non-API response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(throttled())
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()
      await vi.runAllTimersAsync()
      const result = await pending

      expect(mockFetch).toHaveBeenCalledTimes(4)
      expect(result).toEqual({
        ok: false,
        status: 429,
        error: 'Unexpected response from server (HTTP 429)',
      })
      expect(isNonApiResponse(result)).toBe(true)
    })

    it('waits the Retry-After seconds when the response sends them', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(throttled({ 'Retry-After': '2' }))
        .mockResolvedValueOnce(succeeded())
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()

      await vi.advanceTimersByTimeAsync(1999)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      await pending
    })

    it('waits at least its own delay when Retry-After is shorter', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(throttled({ 'Retry-After': '0' }))
        .mockResolvedValueOnce(succeeded())
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()

      await vi.advanceTimersByTimeAsync(249)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      await pending
    })

    it('spreads resends after a Retry-After the same way as its own delays', async () => {
      vi.mocked(Math.random).mockReturnValue(1)
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(throttled({ 'Retry-After': '2' }))
        .mockResolvedValueOnce(succeeded())
      const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()

      // Up to half the 250 ms base delay on top of the 2 s asked for.
      await vi.advanceTimersByTimeAsync(2124)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      await pending
    })

    it('falls back to its own delay for a blank or date-valued Retry-After', async () => {
      for (const retryAfter of ['', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce(throttled({ 'Retry-After': retryAfter }))
          .mockResolvedValueOnce(succeeded())
        const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()

        await vi.advanceTimersByTimeAsync(249)
        expect(mockFetch, `Retry-After: '${retryAfter}'`).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(mockFetch, `Retry-After: '${retryAfter}'`).toHaveBeenCalledTimes(2)
        await pending
      }
    })

    it('does not resend a 429 a handler wrote, or any other status', async () => {
      const handlerBody = { ok: false, status: 429, error: 'Slow down' }
      for (const [status, body] of [
        [429, handlerBody],
        [503, { Message: 'Service Unavailable' }],
      ] as const) {
        const mockFetch = vi
          .fn()
          .mockResolvedValue({ ok: false, status, headers: new Headers(), json: async () => body })
        const pending = new CanopyApiClient({ fetch: mockFetch }).branches.list()
        await vi.runAllTimersAsync()
        await pending
        expect(mockFetch, `HTTP ${status}`).toHaveBeenCalledTimes(1)
      }
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

    it('does not pass through a body whose ok is not a boolean', async () => {
      const client = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ ok: 'yes', data: { branches: [] } }),
        }),
      })
      expect(await client.branches.list()).toEqual({
        ok: false,
        status: 200,
        error: 'Unexpected response from server (HTTP 200)',
      })
    })

    it('marks converted responses, and only those, as not from the API', async () => {
      const respond = (status: number, json: () => Promise<unknown>) =>
        new CanopyApiClient({ fetch: vi.fn().mockResolvedValue({ ok: false, status, json }) })
      const proxy = await respond(404, () =>
        Promise.reject(new SyntaxError('<html>')),
      ).branches.list()
      const api = await respond(404, async () => ({
        ok: false,
        status: 404,
        error: 'Not found',
      })).branches.list()
      expect(isNonApiResponse(proxy)).toBe(true)
      expect(isNonApiResponse(api)).toBe(false)
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

  describe('trailingSlash', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    const okFetch = () =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 200, data: {} }),
      })

    async function requestedUrl(
      options: { trailingSlash?: boolean },
      call: (client: CanopyApiClient) => Promise<unknown>,
    ): Promise<unknown> {
      const mockFetch = okFetch()
      await call(new CanopyApiClient({ ...options, fetch: mockFetch }))
      return mockFetch.mock.calls[0]?.[0]
    }

    it('ends the path with a slash, POST included', async () => {
      expect(await requestedUrl({ trailingSlash: true }, (c) => c.branches.list())).toBe(
        '/api/canopycms/branches/',
      )
      expect(
        await requestedUrl({ trailingSlash: true }, (c) => c.branches.create({ branch: 'b' })),
      ).toBe('/api/canopycms/branches/')
    })

    it('puts the slash before the query string', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.entries.list({ branch: 'main', q: 'search & test' }),
        ),
      ).toBe('/api/canopycms/main/entries/?q=search+%26+test')
    })

    it('adds it after an encoded path param and a rest param', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.permissions.getUserMetadata({ userId: 'user|a b' }),
        ),
      ).toBe('/api/canopycms/users/user%7Ca%20b/')
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.content.read({ branch: 'main', path: 'my collection/my slug' }),
        ),
      ).toBe('/api/canopycms/main/content/my%20collection/my%20slug/')
    })

    it('leaves a file-like last segment unslashed, as Next does', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.admin.deleteTask({ status: 'failed', fileName: 'task-1.json' }),
        ),
      ).toBe('/api/canopycms/admin/tasks/failed/task-1.json')
    })

    it('keeps an encoded ? in a path param apart from the real query string', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.schema.get({ branch: 'a?b', q: 'x/y' }),
        ),
      ).toBe('/api/canopycms/a%3Fb/schema/?q=x%2Fy')
    })

    it('leaves a dotted last segment unslashed when a query string follows it', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.branches.delete({ branch: 'release-1.2', force: 'true' }),
        ),
      ).toBe('/api/canopycms/release-1.2?force=true')
    })

    it('slashes the hand-written multipart upload too', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.assets.uploadProxied(new File(['x'], 'a.png', { type: 'image/png' })),
        ),
      ).toBe('/api/canopycms/assets/upload/')
    })

    it('judges only the last path segment, not a dotted branch or query value', async () => {
      expect(
        await requestedUrl({ trailingSlash: true }, (c) =>
          c.entries.list({ branch: 'release-1.2', q: 'a.json' }),
        ),
      ).toBe('/api/canopycms/release-1.2/entries/?q=a.json')
    })

    it('defaults to the build-time CANOPY_TRAILING_SLASH value', async () => {
      vi.stubEnv('CANOPY_TRAILING_SLASH', 'true')
      expect(await requestedUrl({}, (c) => c.branches.list())).toBe('/api/canopycms/branches/')
      expect(await requestedUrl({ trailingSlash: false }, (c) => c.branches.list())).toBe(
        '/api/canopycms/branches',
      )
    })

    it('is off when neither the option nor the build-time value is set', async () => {
      vi.stubEnv('CANOPY_TRAILING_SLASH', undefined)
      expect(await requestedUrl({}, (c) => c.branches.list())).toBe('/api/canopycms/branches')
      expect(await requestedUrl({}, (c) => c.entries.list({ branch: 'main', q: 'x' }))).toBe(
        '/api/canopycms/main/entries?q=x',
      )
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
