import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'

import { useBranchConflictsData } from './useConflictsData'

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
)

const clientWith = () => {
  const list = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: { conflicts: [], hiddenCount: 0, openCount: 0, held: { at: '2026-11-11T00:00:00Z' } },
  })
  return { list, client: { conflicts: { list } } as never }
}

describe('useBranchConflictsData', () => {
  it('reads nothing while no entry is named, unless asked to', async () => {
    const quiet = clientWith()
    const idle = renderHook(() => useBranchConflictsData(quiet.client, 'feature', []), { wrapper })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(quiet.list).not.toHaveBeenCalled()
    expect(idle.result.current.data).toBeUndefined()

    const asked = clientWith()
    const always = renderHook(() => useBranchConflictsData(asked.client, 'feature', [], true), {
      wrapper,
    })
    await waitFor(() => expect(always.result.current.data?.held).toBeDefined())
    expect(asked.list).toHaveBeenCalledWith({ branch: 'feature' })
  })
})
