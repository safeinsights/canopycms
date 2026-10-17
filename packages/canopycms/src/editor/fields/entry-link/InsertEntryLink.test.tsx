import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ContentId } from '../../../paths/types'
import { CanopyCMSProvider } from '../../theme'
import { EntryLinkContext } from './EntryLinkContext'
import { InsertEntryLink } from './InsertEntryLink'

describe('InsertEntryLink', () => {
  it('escapes link text the editor would otherwise parse as markdown or MDX', async () => {
    const onInsert = vi.fn()
    const label = 'Costs {5} <b> [x] (y) \\ z'
    render(
      <CanopyCMSProvider>
        <EntryLinkContext.Provider
          value={{ entries: [{ contentId: 'abc123' as ContentId, label }] }}
        >
          <InsertEntryLink onInsert={onInsert} />
        </EntryLinkContext.Provider>
      </CanopyCMSProvider>,
    )
    const user = userEvent.setup()

    await user.click(screen.getByTestId('insert-entry-link-button'))
    await user.click(await screen.findByTestId('entry-link-search'))
    await user.click(await screen.findByText(label))

    expect(onInsert).toHaveBeenCalledWith(
      '[Costs \\{5\\} \\<b\\> \\[x\\] \\(y\\) \\\\ z](entry:abc123)',
    )
  })

  it('links a type-named entry by its title, found by its title too', async () => {
    const onInsert = vi.fn()
    render(
      <CanopyCMSProvider>
        <EntryLinkContext.Provider
          value={{
            entries: [{ contentId: 'abc123' as ContentId, label: 'Home', title: 'Welcome home' }],
          }}
        >
          <InsertEntryLink onInsert={onInsert} />
        </EntryLinkContext.Provider>
      </CanopyCMSProvider>,
    )
    const user = userEvent.setup()

    await user.click(screen.getByTestId('insert-entry-link-button'))
    await user.type(await screen.findByTestId('entry-link-search'), 'welcome')
    await user.click(await screen.findByText('Home'))

    expect(onInsert).toHaveBeenCalledWith('[Welcome home](entry:abc123)')
  })
})
