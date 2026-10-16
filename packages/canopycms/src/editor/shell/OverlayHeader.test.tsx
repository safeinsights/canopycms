import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MantineProvider } from '@mantine/core'
import { OverlayDrawer } from './OverlayHeader'

afterEach(cleanup)

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('OverlayDrawer header', () => {
  it('labels the dialog by its title and offers a Close button', async () => {
    const onClose = vi.fn()
    render(
      <OverlayDrawer opened onClose={onClose} position="right" title="Comments">
        <p>body</p>
      </OverlayDrawer>,
      { wrapper },
    )

    const dialog = screen.getByRole('dialog', { name: 'Comments' })
    const heading = within(dialog).getByRole('heading', { name: 'Comments' })
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is as compact as the content panel header: 16px semibold title, md by xs padding, a rule', () => {
    render(
      <OverlayDrawer opened onClose={vi.fn()} position="right" title="Branches">
        <p>body</p>
      </OverlayDrawer>,
      { wrapper },
    )

    const header = document.querySelector<HTMLElement>('.mantine-Drawer-header')!
    expect(header.style.paddingInline).toBe('var(--mantine-spacing-md)')
    expect(header.style.paddingBlock).toBe('var(--mantine-spacing-xs)')
    expect(header.style.minHeight).toBe('0rem')
    expect(header.style.borderBlockEnd).toBe('1px solid var(--canopy-input-border)')
    const title = within(header).getByRole('heading', { name: 'Branches' })
    expect(title.style.fontSize).toBe('var(--mantine-font-size-md)')
    expect(title.style.fontWeight).toBe('600')
  })

  it('keeps the header as a direct sibling above the body, so it can stay pinned', () => {
    render(
      <OverlayDrawer opened onClose={vi.fn()} position="right" title="Media library">
        <p>body</p>
      </OverlayDrawer>,
      { wrapper },
    )

    const header = document.querySelector('.mantine-Drawer-header')!
    expect(header.nextElementSibling?.classList.contains('mantine-Drawer-body')).toBe(true)
  })

  it('puts an adornment inside the heading, so it names the dialog', () => {
    render(
      <OverlayDrawer
        opened
        onClose={vi.fn()}
        position="right"
        title="Groups"
        adornment={<span>Unsaved changes</span>}
      >
        <p>body</p>
      </OverlayDrawer>,
      { wrapper },
    )

    expect(screen.getByRole('dialog', { name: 'Groups Unsaved changes' })).toBeTruthy()
  })
})
