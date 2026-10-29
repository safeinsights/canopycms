import { cleanup, render, screen } from '@testing-library/react'
import { Menu } from '@mantine/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CanopyCMSProvider } from '../theme'
import { ReasonedMenuItem } from './ReasonedMenuItem'

afterEach(cleanup)

const renderItem = (props: Omit<React.ComponentProps<typeof ReasonedMenuItem>, 'children'>) =>
  render(
    <CanopyCMSProvider>
      <Menu opened withinPortal={false}>
        <Menu.Target>
          <button type="button">Open</button>
        </Menu.Target>
        <Menu.Dropdown>
          <ReasonedMenuItem data-testid="item" {...props}>
            Approve
          </ReasonedMenuItem>
        </Menu.Dropdown>
      </Menu>
    </CanopyCMSProvider>,
  )

describe('ReasonedMenuItem aria-describedby', () => {
  it('points a blocked item at a reason printed elsewhere', () => {
    renderItem({ blockedReason: 'Why.', showReason: false, reasonDescribedBy: 'reason-above' })
    expect(screen.getByTestId('item').getAttribute('aria-describedby')).toBe('reason-above')
  })

  it("keeps the caller's own description when no shared reason points elsewhere", () => {
    renderItem({ blockedReason: 'Why.', 'aria-describedby': 'own-note' })
    expect(screen.getByTestId('item').getAttribute('aria-describedby')).toBe('own-note')
  })

  it('keeps it on an item that is not blocked', () => {
    renderItem({ 'aria-describedby': 'own-note', reasonDescribedBy: 'reason-above' })
    expect(screen.getByTestId('item').getAttribute('aria-describedby')).toBe('own-note')
  })
})
