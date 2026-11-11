import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BaseUpdateNotice } from './BaseUpdateNotice'
import { CanopyCMSProvider } from '../theme'

const renderNotice = (props: Parameters<typeof BaseUpdateNotice>[0]) =>
  render(<BaseUpdateNotice {...props} />, { wrapper: CanopyCMSProvider })

describe('BaseUpdateNotice', () => {
  afterEach(cleanup)

  it('is not a live region while waiting: the bar announces the wait', () => {
    renderNotice({ wait: 'waiting' })
    const notice = screen.getByTestId('base-update-waiting-notice')
    expect(notice.getAttribute('role')).toBe('note')
    expect(notice.textContent).toBe(
      'Getting the latest changes. You can edit again when it finishes.',
    )
  })

  it('says a hidden draft comes back', () => {
    renderNotice({ wait: 'waiting', hidesDraft: true })
    expect(screen.getByTestId('base-update-waiting-notice').textContent).toContain(
      'Your unsaved changes come back when it finishes.',
    )
  })

  it('announces the slow phase politely, and can be dismissed', async () => {
    renderNotice({ wait: 'slow' })
    const notice = screen.getByTestId('base-update-slow-notice')
    expect(notice.getAttribute('role')).toBe('status')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('base-update-slow-notice')).toBeNull()
  })
})
