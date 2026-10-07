import { describe, expect, it, vi } from 'vitest'

const requestHeaders = vi.hoisted(() => ({ read: vi.fn<() => Promise<Headers>>() }))
import type { CanopyConfig } from 'canopycms'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, cache: <T>(fn: T): T => fn }
})
vi.mock('canopycms/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('canopycms/server')>()
  return {
    ...actual,
    createCanopyServices: vi.fn(async (config: CanopyConfig) => ({
      config,
      bootstrapAdminIds: new Set<string>(),
      refreshActiveBranch: vi.fn(),
      getSettingsBranchRoot: vi.fn(async () => '/nonexistent/canopy-settings'),
    })),
    startDevContentWatcher: vi.fn(),
  }
})
vi.mock('canopycms/client', () => ({ CanopyEditorPage: vi.fn(), useCanopyPreview: vi.fn() }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
  useSearchParams: () => new URLSearchParams(),
}))
// A request-scoped read starts by reading the request's headers; failing there marks that the
// page went on to read through getCanopy().
vi.mock('next/headers', () => ({ headers: () => requestHeaders.read() }))
requestHeaders.read.mockRejectedValue(new Error('REQUEST_SCOPED_READ'))

const { createNextCanopyContext } = await import('./context-wrapper')

const previewRequest = {
  params: Promise.resolve({ path: ['posts', 'hello'] }),
  searchParams: Promise.resolve({ branch: 'feature' }),
}

describe('createNextCanopyContext().createPreviewPage', () => {
  it("is a 404 on a deployedAs: 'static' deployment, whose reads skip access checks", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const context = await createNextCanopyContext({
      config: { mode: 'dev', deployedAs: 'static' } as CanopyConfig,
      entrySchemaRegistry: {},
    })

    await expect(context.createPreviewPage({ views: {} })(previewRequest)).rejects.toThrow(
      'NEXT_NOT_FOUND',
    )
  })

  it('reads through the request-scoped context on a server deployment', async () => {
    const context = await createNextCanopyContext({
      config: { mode: 'dev', deployedAs: 'server' } as CanopyConfig,
      authPlugin: {
        authenticate: async () => ({ success: false, error: 'unused' }),
        searchUsers: async () => [],
        getUserMetadata: async () => null,
        getGroupMetadata: async () => null,
        listGroups: async () => [],
      },
      entrySchemaRegistry: {},
    })

    await expect(context.createPreviewPage({ views: {} })(previewRequest)).rejects.toThrow(
      'REQUEST_SCOPED_READ',
    )
  })

  it('resolves a request with no session to the anonymous user the preview page 404s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    requestHeaders.read.mockResolvedValueOnce(new Headers())
    const authenticate = vi.fn(async () => ({ success: false as const, error: 'no session' }))
    const context = await createNextCanopyContext({
      config: { mode: 'dev', deployedAs: 'server' } as CanopyConfig,
      authPlugin: {
        authenticate,
        searchUsers: async () => [],
        getUserMetadata: async () => null,
        getGroupMetadata: async () => null,
        listGroups: async () => [],
      },
      entrySchemaRegistry: {},
    })

    const { user } = await context.getCanopy()

    expect(authenticate).toHaveBeenCalledOnce()
    expect(user.type).toBe('anonymous')
  })
})
