import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { ReferenceField, type ReferenceOption } from './ReferenceField'
import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import type { ReferenceOptionsResponse } from '../../api/reference-options'
import type { ReferenceOptionSort } from '../../config'

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
  initial?: string
  optionSort?: ReferenceOptionSort
}> = ({ options, collections, entryTypes, branch = 'main', initial = '', optionSort }) => {
  const [value, setValue] = useState(initial)
  return (
    <CanopyCMSProvider>
      <ReferenceField
        label="Author"
        options={options}
        collections={collections}
        entryTypes={entryTypes}
        branch={branch}
        optionSort={optionSort}
        value={value}
        onChange={setValue}
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

  describe('a value the options do not offer', () => {
    const options = [{ value: 'Bob000000001', label: 'Bob' }]

    /** The field as FormRenderer drives it, starting from a value a read resolved. */
    const ValueHarness: React.FC<{ initial: unknown }> = ({ initial }) => {
      const [value, setValue] = useState(initial)
      return (
        <CanopyCMSProvider>
          <ReferenceField
            label="Author"
            options={options}
            value={value}
            onChange={setValue}
            dataCanopyField="author"
          />
          <output data-testid="value">{JSON.stringify(value)}</output>
        </CanopyCMSProvider>
      )
    }

    it('shows a missing target as missing rather than an empty field', () => {
      render(
        <ValueHarness initial={{ id: 'Gone00000001', unavailable: true, reason: 'missing' }} />,
      )
      expect(screen.getByDisplayValue('Missing entry (Gone00000001)')).toBeTruthy()
    })

    it('shows a restricted target by its title', () => {
      render(
        <ValueHarness
          initial={{
            id: 'Secret000001',
            slug: 'agent',
            collection: 'content/private',
            urlPath: '/private/agent',
            title: 'Agent X',
            unavailable: true,
            reason: 'restricted',
          }}
        />,
      )
      expect(screen.getByDisplayValue('Restricted entry: Agent X')).toBeTruthy()
    })
  })

  describe('a pick hidden from search', () => {
    const OPTIONS: ReferenceOption[] = [
      { value: 'p1', label: 'Launch post', noindex: { fieldLabel: 'Hide from search engines' } },
      { value: 'p2', label: 'Recap post' },
    ]

    it('badges the pick beside the input and says why', () => {
      render(<Harness options={OPTIONS} initial="p1" />)
      const field = screen.getByTestId('reference-field-author')
      expect(within(field).getByText('Hidden from search')).toBeTruthy()
      expect(screen.getByTestId('reference-hidden-note').textContent).toBe(
        '\u2018Launch post\u2019 has \u201cHide from search engines\u201d turned on, so pages ' +
          "that list only visible entries won't show it.",
      )
    })

    it('shows neither for a visible pick', () => {
      render(<Harness options={OPTIONS} initial="p2" />)
      const field = screen.getByTestId('reference-field-author')
      expect(within(field).queryByText('Hidden from search')).toBeNull()
      expect(screen.queryByTestId('reference-hidden-note')).toBeNull()
    })

    it('holds both back until the options arrive', async () => {
      let settle: (value: ReferenceOptionsResponse) => void = () => {}
      mockClient.content.getReferenceOptions.mockImplementation(
        () => new Promise<ReferenceOptionsResponse>((resolve) => (settle = resolve)),
      )
      render(<Harness collections={['posts']} initial="p1" />)
      expect(screen.queryByTestId('reference-hidden-note')).toBeNull()

      await act(async () =>
        settle({
          ok: true,
          status: 200,
          data: {
            options: [
              {
                id: 'p1',
                label: 'Launch post',
                collection: 'posts',
                noindex: { fieldLabel: 'Hide from search engines' },
              },
            ],
          },
        }),
      )
      expect(screen.getByTestId('reference-hidden-note')).toBeTruthy()
    })
  })

  it.each([
    ['collection' as const, { sort: 'collection' }],
    [{ field: 'meta.date' }, { sort: 'field', sortField: 'meta.date' }],
  ])('asks the endpoint for optionSort %j', async (optionSort, params) => {
    mockClient.content.getReferenceOptions.mockResolvedValue({
      ok: true,
      status: 200,
      data: { options: [] },
    })
    render(<Harness collections={['posts']} optionSort={optionSort} />)
    await waitFor(() =>
      expect(mockClient.content.getReferenceOptions).toHaveBeenCalledWith({
        branch: 'main',
        displayField: 'title',
        collections: 'posts',
        ...params,
      }),
    )
  })
})
