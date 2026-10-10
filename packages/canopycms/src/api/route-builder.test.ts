import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineEndpoint } from './route-builder'
import type { ApiContext, ApiResponse } from './types'
import { createMockApiContext, createMockBranchContext, createMockUser } from '../test-utils'

describe('defineEndpoint: recording branch editors', () => {
  const branchContext = createMockBranchContext({ branchName: 'feature-x' })
  const req = { user: createMockUser('user') }

  function endpoint(guard: 'writableBranch' | 'branchAccess', response: ApiResponse<unknown>) {
    return defineEndpoint({
      namespace: 'test',
      name: `recordEditor-${guard}`,
      method: 'POST',
      path: '/:branch/test-record-editor',
      params: z.object({ branch: z.string() }),
      responseType: 'ApiResponse',
      response: {} as ApiResponse<unknown>,
      guards: [guard] as const,
      handler: async () => response,
    })
  }

  function context(): ApiContext {
    return createMockApiContext({ branchContext })
  }

  it("records the user after a 'writableBranch' endpoint succeeds", async () => {
    const ctx = context()

    await endpoint('writableBranch', { ok: true, status: 200 }).handler(ctx, req, {
      branch: 'feature-x',
    })

    expect(ctx.services.recordBranchEditor).toHaveBeenCalledWith(branchContext, req.user)
  })

  it('records no one when the endpoint fails', async () => {
    const ctx = context()

    await endpoint('writableBranch', { ok: false, status: 409, error: 'conflict' }).handler(
      ctx,
      req,
      { branch: 'feature-x' },
    )

    expect(ctx.services.recordBranchEditor).not.toHaveBeenCalled()
  })

  it("records no one for an endpoint without the 'writableBranch' guard", async () => {
    const ctx = context()

    await endpoint('branchAccess', { ok: true, status: 200 }).handler(ctx, req, {
      branch: 'feature-x',
    })

    expect(ctx.services.recordBranchEditor).not.toHaveBeenCalled()
  })

  it('returns the handler response unchanged', async () => {
    const response = { ok: true as const, status: 200, data: { saved: 1 } }

    const result = await endpoint('writableBranch', response).handler(context(), req, {
      branch: 'feature-x',
    })

    expect(result).toBe(response)
  })
})
