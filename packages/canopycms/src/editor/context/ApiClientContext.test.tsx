import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiClientProvider, useApiClient } from './ApiClientContext'

/**
 * ApiClientProvider builds the API client with `baseUrl: joinUrlPrefix(basePath,
 * '/api/canopycms')` (see ApiClientContext.tsx). These tests assert the client actually
 * issues requests against that prefixed base -- not just that the constructor received the
 * right option -- by mocking the global `fetch` the client falls back to when no explicit
 * `fetch` override is supplied (as `createApiClient()` never gets one here), and reading the
 * URL the mock was called with.
 */
describe('ApiClientProvider basePath wiring', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: 200, data: { branches: [] } }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const Consumer: React.FC = () => {
    const client = useApiClient()
    React.useEffect(() => {
      client.branches.list()
    }, [client])
    return null
  }

  it('issues requests against the deployment-prefixed base when basePath is configured', async () => {
    render(
      <ApiClientProvider basePath="/preview-123">
        <Consumer />
      </ApiClientProvider>,
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url] = fetchMock.mock.calls[0] as [string, unknown]
    expect(url).toBe('/preview-123/api/canopycms/branches')
  })

  it('defaults to /api/canopycms with no basePath configured (regression guard)', async () => {
    render(
      <ApiClientProvider>
        <Consumer />
      </ApiClientProvider>,
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url] = fetchMock.mock.calls[0] as [string, unknown]
    expect(url).toBe('/api/canopycms/branches')
  })

  it('normalizes a basePath missing its leading slash the same way', async () => {
    render(
      <ApiClientProvider basePath="preview-123">
        <Consumer />
      </ApiClientProvider>,
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url] = fetchMock.mock.calls[0] as [string, unknown]
    expect(url).toBe('/preview-123/api/canopycms/branches')
  })

  it('ignores basePath when an explicit client is injected (testing escape hatch keeps working)', async () => {
    const injectedFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: 200, data: { branches: [] } }),
    })
    const { createApiClient } = await import('../../api')
    const injectedClient = createApiClient({ baseUrl: '/injected', fetch: injectedFetch })

    render(
      <ApiClientProvider client={injectedClient} basePath="/preview-123">
        <Consumer />
      </ApiClientProvider>,
    )

    await waitFor(() => expect(injectedFetch).toHaveBeenCalled())
    const [url] = injectedFetch.mock.calls[0] as [string, unknown]
    expect(url).toBe('/injected/branches')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
