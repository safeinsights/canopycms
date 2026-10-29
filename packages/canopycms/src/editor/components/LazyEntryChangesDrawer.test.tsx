import React, { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../../config'
import { mockConsole } from '../../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../../test-utils/render-errors'
import { CanopyCMSProvider } from '../theme'
import type { EntryChangesDrawerProps } from './EntryChangesDrawer'
import { LazyEntryChangesDrawer, type LazyEntryChangesDrawerProps } from './LazyEntryChangesDrawer'

afterEach(() => cleanup())

const state: EntryChangesDrawerProps['state'] = {
  data: {
    before: { format: 'json', entryType: 'post', data: { title: 'Hello' } },
    after: { format: 'json', entryType: 'post', data: { title: 'Hello there' } },
    mergeBaseSha: 'a'.repeat(40),
  },
  error: undefined,
  isValidating: false,
  reload: async () => {},
}
const fields: FieldConfig[] = [{ name: 'title', type: 'string', label: 'Title' }]

/** The editor's other content beside a drawer it opens and closes. */
const Harness: React.FC<Partial<LazyEntryChangesDrawerProps>> = (props) => {
  const [opened, setOpened] = useState(false)
  return (
    <CanopyCMSProvider>
      <p>The rest of the editor</p>
      <button type="button" onClick={() => setOpened(true)}>
        Show changes
      </button>
      <LazyEntryChangesDrawer
        opened={opened}
        onClose={() => setOpened(false)}
        base="main"
        subject={{ logicalPath: 'content/blog/hello', status: 'modified', title: 'Hello', fields }}
        state={state}
        {...props}
      />
    </CanopyCMSProvider>
  )
}

const open = () => userEvent.click(screen.getByRole('button', { name: 'Show changes' }))
const dialog = () => screen.findByRole('dialog', { name: 'Changes to Hello' })

describe('LazyEntryChangesDrawer', () => {
  it('loads the drawer on its first open, not before', async () => {
    const load = vi.fn(() =>
      import('./EntryChangesDrawer').then((m) => ({ default: m.EntryChangesDrawer })),
    )
    render(<Harness load={load} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(load).not.toHaveBeenCalled()
    await open()
    // The skeleton drawer shown while the chunk loads gives way to the drawer itself.
    expect(await screen.findByTestId('entry-changes-summary')).toBeTruthy()
  })

  it('shows a drawer of loading skeletons while the chunk loads', async () => {
    render(<Harness load={() => new Promise(() => {})} />)
    await open()
    const shown = await dialog()
    expect(within(shown).getByRole('status').textContent).toBe('Loading changes…')
    expect(within(shown).getByTestId('entry-changes-loading')).toBeTruthy()
  })

  it('shows its own fallback when the chunk fails to load, and loads afresh on the next open', async () => {
    const consoleSpy = mockConsole()
    const unsilence = silenceReportedRenderErrors()
    try {
      const real = () =>
        import('./EntryChangesDrawer').then((m) => ({ default: m.EntryChangesDrawer }))
      const load = vi
        .fn<NonNullable<LazyEntryChangesDrawerProps['load']>>()
        .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
        .mockImplementation(real)
      const onExited = vi.fn()
      render(<Harness load={load} onExited={onExited} />)
      await open()
      const crashed = await within(await dialog()).findByTestId('entry-changes-crashed')
      expect(crashed.textContent).toContain(
        'Changes couldn’t be shown. Close and reopen to try again, or reload the page.',
      )
      expect(screen.getByText('The rest of the editor')).toBeTruthy()

      await userEvent.click(within(crashed).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // The crashed drawer's close ends its comparison's fetching too.
      await waitFor(() => expect(onExited).toHaveBeenCalledTimes(1))
      await open()
      expect(await screen.findByTestId('entry-changes-summary')).toBeTruthy()
      expect(load).toHaveBeenCalledTimes(2)
      expect(consoleSpy).toHaveErrored(/editor error caught/)
    } finally {
      unsilence()
      consoleSpy.restore()
    }
  })

  it('shows its own fallback when the comparison throws, leaving the editor up', async () => {
    const consoleSpy = mockConsole()
    const unsilence = silenceReportedRenderErrors()
    try {
      const throwing = new Proxy([] as FieldConfig[], {
        get() {
          throw new Error('Comparison failed')
        },
      })
      render(
        <Harness
          subject={{
            logicalPath: 'content/blog/hello',
            status: 'modified',
            title: 'Hello',
            fields: throwing,
          }}
        />,
      )
      await open()
      expect(await within(await dialog()).findByTestId('entry-changes-crashed')).toBeTruthy()
      expect(screen.getByText('The rest of the editor')).toBeTruthy()
      expect(consoleSpy).toHaveErrored(/editor error caught/)
    } finally {
      unsilence()
      consoleSpy.restore()
    }
  })
})
