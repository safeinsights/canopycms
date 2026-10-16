/**
 * An optional object's Clear sits in its "…" menu, and its Undo stays in the object's label row
 * until the object is edited, the entry changes, or the entry is saved or discarded.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommentThread } from '../comment-store'
import type { FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { CanopyCMSProvider } from './theme'
import type { MockApiClient } from '../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from './hooks/__test__/test-utils'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, createApiClient: vi.fn() }
})

let mockClient: MockApiClient
beforeEach(async () => {
  mockClient = await setupMockApiClient()
})
afterEach(() => cleanup())

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'seo',
    type: 'object',
    label: 'SEO',
    fields: [
      { name: 'summary', type: 'string', label: 'Summary' },
      {
        name: 'links',
        type: 'object',
        label: 'Links',
        list: true,
        fields: [{ name: 'href', type: 'string', label: 'Href' }],
      },
    ],
  },
]

const HOME = 'content/pages/home'
const ABOUT = 'content/pages/about'
const savedSeo = { summary: 'Saved summary' }

/** Holds saved copies and drafts per entry, as the editor does, with Save and Discard. */
const Harness: React.FC<{
  readOnly?: boolean
  comments?: CommentThread[]
  onRemoved?: () => void
  /** False passes the form no saved copy, which leaves the entry path to tell entries apart. */
  passSavedValue?: boolean
}> = ({ readOnly = false, comments, onRemoved, passSavedValue = true }) => {
  const [entryPath, setEntryPath] = useState(HOME)
  const [saved, setSaved] = useState<Record<string, FormValue>>({
    [HOME]: { title: 'Home', seo: savedSeo },
    // No SEO, so a Clear made on Home could otherwise be undone here.
    [ABOUT]: { title: 'About' },
  })
  const [drafts, setDrafts] = useState<Record<string, FormValue>>({})
  const savedValue = saved[entryPath]
  const value = drafts[entryPath] ?? savedValue
  const dropDraft = () =>
    setDrafts((prev) => {
      const { [entryPath]: _dropped, ...rest } = prev
      return rest
    })
  // Made once: a component made per render would remount the form, and its state with it.
  const [Wrapper] = useState(() => createApiClientWrapper(mockClient))
  return (
    <CanopyCMSProvider>
      <Wrapper>
        <button type="button" onClick={() => setEntryPath(entryPath === HOME ? ABOUT : HOME)}>
          Switch entry
        </button>
        <button
          type="button"
          onClick={() => {
            setSaved((prev) => ({ ...prev, [entryPath]: { ...value } }))
            dropDraft()
          }}
        >
          Save
        </button>
        <button type="button" onClick={dropDraft}>
          Discard
        </button>
        {/* As Save all does when an edit lands while the save is out: the draft stays. */}
        <button
          type="button"
          onClick={() => setSaved((prev) => ({ ...prev, [entryPath]: { ...value } }))}
        >
          Save, keeping a draft
        </button>
        <pre data-testid="value">{JSON.stringify(value)}</pre>
        <FormRenderer
          fields={fields}
          value={value}
          savedValue={passSavedValue ? savedValue : undefined}
          currentEntryPath={entryPath}
          comments={comments}
          readOnly={readOnly}
          onRemoved={onRemoved}
          onChange={(next) => setDrafts((prev) => ({ ...prev, [entryPath]: next }))}
        />
      </Wrapper>
    </CanopyCMSProvider>
  )
}

const shown = (): FormValue => JSON.parse(screen.getByTestId('value').textContent ?? '{}')
const seoGroup = () => screen.getByRole('group', { name: 'SEO' })
const undoButton = () => screen.queryByRole('button', { name: 'Undo clear "SEO"' })

/** Opens the object's "…" menu and chooses Clear, as a person does. */
const clearSeo = async () => {
  fireEvent.click(within(seoGroup()).getByRole('button', { name: 'Actions for SEO' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear "SEO"' }))
}

describe('Clear on an optional object', () => {
  it('sits in the object\'s "…" menu, named for the object, not on the label row', async () => {
    render(<Harness />)
    expect(screen.queryByRole('button', { name: /^Clear\b/ })).toBeNull()

    fireEvent.click(within(seoGroup()).getByRole('button', { name: 'Actions for SEO' }))

    const item = await screen.findByRole('menuitem', { name: 'Clear "SEO"' })
    expect(item.textContent).toBe('Clear "SEO"')
  })

  it('clears to an inline Undo, announced, with focus on it and no toast', async () => {
    const onRemoved = vi.fn()
    render(<Harness onRemoved={onRemoved} />)

    await clearSeo()

    expect(shown().seo).toBeUndefined()
    const undo = undoButton()
    expect(undo).not.toBeNull()
    expect(undo?.textContent).toBe('Undo clear')
    expect(within(seoGroup()).queryByRole('button', { name: 'Actions for SEO' })).toBeNull()
    expect(within(seoGroup()).getByText('Cleared "SEO".').getAttribute('role')).toBe('status')
    await waitFor(() => expect(document.activeElement).toBe(undo))
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('puts the object back into the value as it is now, and focuses it', async () => {
    render(<Harness />)
    await clearSeo()
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Edited title' },
    })

    act(() => fireEvent.click(undoButton()!))

    expect(shown()).toEqual({ title: 'Edited title', seo: savedSeo })
    expect(undoButton()).toBeNull()
    expect(within(seoGroup()).getByRole('button', { name: 'Actions for SEO' })).toBeTruthy()
    const summary = screen.getByRole('textbox', { name: 'Summary' })
    await waitFor(() => expect(document.activeElement).toBe(summary))
    expect((summary as HTMLInputElement).value).toBe('Saved summary')
  })

  it('ends once the object is filled in again', async () => {
    render(<Harness />)
    await clearSeo()

    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Typed after' },
    })

    expect(shown().seo).toEqual({ summary: 'Typed after' })
    expect(undoButton()).toBeNull()
  })

  it('stays while another field is edited', async () => {
    render(<Harness />)
    await clearSeo()

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Edited title' },
    })

    expect(undoButton()).not.toBeNull()
  })

  it('ends when the entry changes, and stays gone on coming back', async () => {
    render(<Harness passSavedValue={false} />)
    // About gets a draft too, so it shows one with no SEO, which the Clear could put back into.
    fireEvent.click(screen.getByRole('button', { name: 'Switch entry' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'About us' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch entry' }))
    await clearSeo()

    fireEvent.click(screen.getByRole('button', { name: 'Switch entry' }))
    expect(shown()).toEqual({ title: 'About us' })
    expect(undoButton()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Switch entry' }))
    expect(shown()).toEqual({ title: 'Home' })
    expect(undoButton()).toBeNull()
  })

  it('ends when the entry is saved', async () => {
    render(<Harness />)
    await clearSeo()
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Edited title' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(shown()).toEqual({ title: 'Edited title' })
    expect(undoButton()).toBeNull()
  })

  it('ends when the entry is saved while a draft stays', async () => {
    render(<Harness />)
    await clearSeo()

    fireEvent.click(screen.getByRole('button', { name: 'Save, keeping a draft' }))

    expect(shown()).toEqual({ title: 'Home' })
    expect(undoButton()).toBeNull()
  })

  it('ends when the draft is discarded, though the saved copy has no object either', async () => {
    render(<Harness />)
    // About's SEO is filled in only in its draft.
    fireEvent.click(screen.getByRole('button', { name: 'Switch entry' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Draft summary' },
    })
    await clearSeo()
    expect(undoButton()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(shown()).toEqual({ title: 'About' })
    expect(undoButton()).toBeNull()
  })

  it('says where comment threads on items inside it went', async () => {
    const thread = {
      id: 't1',
      type: 'field',
      entryPath: HOME,
      canopyPath: 'seo.links[0].href',
      itemKeys: ['k0'],
      resolved: false,
      authorId: 'u',
      createdAt: '2024-01-01T00:00:00Z',
      comments: [],
    } as unknown as CommentThread
    render(<Harness comments={[thread]} />)

    await clearSeo()

    const note = 'Its comment thread moved to "Comment on this entry".'
    expect(within(seoGroup()).getByText(note)).toBeTruthy()
    const announced = within(seoGroup()).getByText(`Cleared "SEO". ${note}`)
    expect(announced.getAttribute('role')).toBe('status')
  })

  it('offers neither the menu nor an Undo on a read-only form', async () => {
    const { rerender } = render(<Harness />)
    await clearSeo()
    expect(undoButton()).not.toBeNull()

    // The branch locks while the Undo shows.
    rerender(<Harness readOnly />)
    expect(undoButton()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(shown().seo).toEqual(savedSeo)
    expect(within(seoGroup()).queryByRole('button', { name: 'Actions for SEO' })).toBeNull()
  })
})
