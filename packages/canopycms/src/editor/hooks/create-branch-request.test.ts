import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BranchListItem } from '../../api/branch'
import { CanopyApiClient } from '../../api/client'
import {
  CREATE_BRANCH_DEADLINE_MS,
  CREATE_TIMED_OUT_MESSAGE,
  requestBranchCreate,
} from './create-branch-request'

interface FakeResponse {
  status: number
  /** A JSON body; omitted for an HTML error page from in front of the API. */
  body?: unknown
}

const branch = (name: string): BranchListItem =>
  ({ name, status: 'editing', access: {}, createdBy: 'u1' }) as unknown as BranchListItem

const listing = (...names: string[]): FakeResponse => ({
  status: 200,
  body: { ok: true, status: 200, data: { branches: names.map(branch) } },
})

const never = (): Promise<FakeResponse> => new Promise(() => {})

/** A real client whose fetch answers POST with `create` and GET with `list`. */
function client(create: () => Promise<FakeResponse>, list = vi.fn(async () => listing())) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const answer = await (init?.method === 'POST' ? create() : list())
    return {
      ok: answer.status < 400,
      status: answer.status,
      headers: new Headers(),
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError('Unexpected token <')
        return answer.body
      },
    } as unknown as Response
  })
  return { apiClient: new CanopyApiClient({ fetch, trailingSlash: false }), list }
}

const body = { branch: 'feature/x' }

describe('requestBranchCreate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the created branch', async () => {
    const { apiClient, list } = client(async () => ({
      status: 200,
      body: { ok: true, status: 200, data: { branch: branch('feature-x') } },
    }))

    expect(await requestBranchCreate(apiClient, body)).toEqual({
      kind: 'created',
      branch: branch('feature-x'),
    })
    expect(list).not.toHaveBeenCalled()
  })

  it("reports the server's refusal without looking for the branch", async () => {
    const { apiClient, list } = client(async () => ({
      status: 409,
      body: { ok: false, status: 409, error: 'Branch already exists' },
    }))

    expect(await requestBranchCreate(apiClient, body)).toEqual({
      kind: 'failed',
      message: 'Branch already exists',
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('after the deadline, adopts the branch when the list shows it under its sanitized name', async () => {
    const { apiClient, list } = client(
      never,
      vi.fn(async () => listing('main', 'feature-x')),
    )

    const outcome = requestBranchCreate(apiClient, body)
    await vi.advanceTimersByTimeAsync(CREATE_BRANCH_DEADLINE_MS - 1)
    expect(list).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(await outcome).toEqual({ kind: 'created', branch: branch('feature-x') })
  })

  it('after the deadline, says so plainly when the branch is not there', async () => {
    const { apiClient } = client(
      never,
      vi.fn(async () => listing('main')),
    )

    const outcome = requestBranchCreate(apiClient, body)
    await vi.advanceTimersByTimeAsync(CREATE_BRANCH_DEADLINE_MS)

    expect(await outcome).toEqual({ kind: 'failed', message: CREATE_TIMED_OUT_MESSAGE })
    expect(CREATE_TIMED_OUT_MESSAGE).toBe(
      "Creating the branch didn't finish (the server timed out). It's safe to try again.",
    )
  })

  it('looks for the branch after a gateway timeout page from in front of the API', async () => {
    const found = client(
      async () => ({ status: 504 }),
      vi.fn(async () => listing('feature-x')),
    )
    expect(await requestBranchCreate(found.apiClient, body)).toEqual({
      kind: 'created',
      branch: branch('feature-x'),
    })

    const missing = client(async () => ({ status: 504 }))
    expect(await requestBranchCreate(missing.apiClient, body)).toEqual({
      kind: 'failed',
      message: CREATE_TIMED_OUT_MESSAGE,
    })
    expect(missing.list).toHaveBeenCalledTimes(1)
  })

  it("looks for the branch after a busy 503, and otherwise shows the server's message", async () => {
    const busy = async (): Promise<FakeResponse> => ({
      status: 503,
      body: { ok: false, status: 503, error: "Branch 'feature-x' is being created. Try again." },
    })

    const missing = client(busy)
    expect(await requestBranchCreate(missing.apiClient, body)).toEqual({
      kind: 'failed',
      message: "Branch 'feature-x' is being created. Try again.",
    })
    expect(missing.list).toHaveBeenCalledTimes(1)

    const found = client(
      busy,
      vi.fn(async () => listing('feature-x')),
    )
    expect(await requestBranchCreate(found.apiClient, body)).toEqual({
      kind: 'created',
      branch: branch('feature-x'),
    })
  })

  it('reports the timeout when the branch list cannot be read either', async () => {
    const { apiClient } = client(
      async () => ({ status: 504 }),
      vi.fn(async (): Promise<FakeResponse> => ({ status: 502 })),
    )

    expect(await requestBranchCreate(apiClient, body)).toEqual({
      kind: 'failed',
      message: CREATE_TIMED_OUT_MESSAGE,
    })
  })
})
