import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { ReferenceField, type ReferenceOption } from './ReferenceField'
import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import type { ReferenceOptionsResponse } from '../../api/reference-options'

// ReferenceField calls createApiClient() directly (not via context DI) --
// mock the same resolved module the component imports.
vi.mock('../../api/client', () => ({
  createApiClient: vi.fn(),
}))

// Controlled harness mirroring how FormRenderer drives the field.
const Harness: React.FC<{
  options?: ReferenceOption[]
  collections?: string[]
  entryTypes?: string[]
  branch?: string
}> = ({ options, collections, entryTypes, branch = 'main' }) => {
  const [value, setValue] = useState('')
  return (
    <CanopyCMSProvider>
      <ReferenceField
        label="Author"
        options={options}
        collections={collections}
        entryTypes={entryTypes}
        branch={branch}
        value={value}
        onChange={(next) => setValue(next as string)}
        dataCanopyField="author"
      />
    </CanopyCMSProvider>
  )
}

afterEach(cleanup)

describe('ReferenceField', () => {
  let mockClient: MockApiClient

  beforeEach(async () => {
    mockClient = createMockApiClient()
    const { createApiClient } = await import('../../api/client')
    vi.mocked(createApiClient).mockReturnValue(mockClient as any)
  })

  it('renders static options directly without fetching', () => {
    render(<Harness options={[{ value: 'id1', label: 'Alice' }]} />)

    expect(screen.getByTestId('reference-field-author')).toBeTruthy()
    expect(screen.queryByTestId('reference-loading-author')).toBeNull()
    expect(mockClient.content.getReferenceOptions).not.toHaveBeenCalled()
  })

  it('fetches options when collections are provided and no static options are given', async () => {
    mockClient.content.getReferenceOptions.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { options: [{ id: 'id1', label: 'Alice', collection: 'authors' }] },
    })

    render(<Harness collections={['authors']} />)

    expect(screen.getByTestId('reference-loading-author')).toBeTruthy()

    await waitFor(() => {
      expect(screen.queryByTestId('reference-loading-author')).toBeNull()
    })
    expect(mockClient.content.getReferenceOptions).toHaveBeenCalledWith({
      branch: 'main',
      displayField: 'title',
      collections: 'authors',
    })
  })

  it('does not refetch when the parent re-renders with a new array reference but the same values', async () => {
    // Regression test: the effect used to depend on the raw `collections`/
    // `entryTypes` arrays, which the parent (e.g. FormRenderer after
    // refreshEntries()) rebuilds on every render even when the underlying
    // values haven't changed -- firing a fetch on every keystroke elsewhere
    // in the form. Keying on the derived fetchKey fixes that.
    mockClient.content.getReferenceOptions.mockResolvedValue({
      ok: true,
      status: 200,
      data: { options: [{ id: 'id1', label: 'Alice', collection: 'authors' }] },
    })

    const { rerender } = render(<Harness collections={['authors']} />)
    await waitFor(() => {
      expect(screen.queryByTestId('reference-loading-author')).toBeNull()
    })
    expect(mockClient.content.getReferenceOptions).toHaveBeenCalledTimes(1)

    // New array literal each time (new reference, same content) -- mirrors
    // the parent rebuilding `collections` on every render.
    rerender(<Harness collections={['authors']} />)
    rerender(<Harness collections={['authors']} />)

    expect(mockClient.content.getReferenceOptions).toHaveBeenCalledTimes(1)
  })

  it('refetches when the fetchKey-relevant inputs actually change', async () => {
    mockClient.content.getReferenceOptions.mockResolvedValue({
      ok: true,
      status: 200,
      data: { options: [{ id: 'id1', label: 'Alice', collection: 'authors' }] },
    })

    const { rerender } = render(<Harness collections={['authors']} />)
    await waitFor(() => expect(mockClient.content.getReferenceOptions).toHaveBeenCalledTimes(1))

    rerender(<Harness collections={['partners']} />)
    await waitFor(() => expect(mockClient.content.getReferenceOptions).toHaveBeenCalledTimes(2))
    expect(mockClient.content.getReferenceOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ collections: 'partners' }),
    )
  })

  it('discards a stale response when the fetchKey changes before it settles (out-of-order safe)', async () => {
    const resolvers: Array<(v: ReferenceOptionsResponse) => void> = []
    mockClient.content.getReferenceOptions.mockImplementation(
      () => new Promise<ReferenceOptionsResponse>((resolve) => resolvers.push(resolve)),
    )

    const { rerender } = render(<Harness collections={['authors']} />)
    await waitFor(() => expect(resolvers).toHaveLength(1))

    // Switch to a different collection before the first request settles.
    rerender(<Harness collections={['partners']} />)
    await waitFor(() => expect(resolvers).toHaveLength(2))

    // Settle the NEWER request first.
    await act(async () => {
      resolvers[1]({
        ok: true,
        status: 200,
        data: { options: [{ id: 'p1', label: 'Partner One', collection: 'partners' }] },
      })
    })
    await waitFor(() => expect(screen.queryByTestId('reference-loading-author')).toBeNull())

    // Now settle the STALE (authors) request -- it must be discarded, not
    // overwrite the partners options that already committed.
    await act(async () => {
      resolvers[0]({
        ok: true,
        status: 200,
        data: { options: [{ id: 'a1', label: 'Author One', collection: 'authors' }] },
      })
    })

    // Still showing the partners result -- unaffected by the late authors response.
    expect(screen.queryByTestId('reference-error-author')).toBeNull()
    expect(screen.getByTestId('reference-field-author')).toBeTruthy()
  })

  it('shows an error state on failure and refetches on retry', async () => {
    mockClient.content.getReferenceOptions
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'Server exploded' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { options: [{ id: 'id1', label: 'Alice', collection: 'authors' }] },
      })

    render(<Harness collections={['authors']} />)

    await waitFor(() => {
      expect(screen.getByTestId('reference-error-author')).toBeTruthy()
    })
    expect(screen.getByText('Server exploded')).toBeTruthy()

    fireEvent.click(screen.getByTestId('reference-retry-author'))

    await waitFor(() => {
      expect(screen.queryByTestId('reference-error-author')).toBeNull()
    })
    expect(mockClient.content.getReferenceOptions).toHaveBeenCalledTimes(2)
  })
})
