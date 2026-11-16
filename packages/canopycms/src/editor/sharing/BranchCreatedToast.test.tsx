import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Notification } from '@mantine/core'

import { CanopyCMSProvider } from '../theme'
import { BranchCreatedToast } from './BranchCreatedToast'

function renderToast() {
  const onHold = vi.fn()
  const onRelease = vi.fn()
  render(
    <CanopyCMSProvider>
      <button>Elsewhere</button>
      <Notification withCloseButton closeButtonProps={{ 'aria-label': 'Close' }}>
        <BranchCreatedToast
          label="spring"
          onShare={() => {}}
          onHold={onHold}
          onRelease={onRelease}
        />
      </Notification>
    </CanopyCMSProvider>,
  )
  return { onHold, onRelease }
}

describe('BranchCreatedToast', () => {
  afterEach(() => cleanup())

  it('holds its timer while focus is anywhere in the notification, its close button included', async () => {
    const { onHold, onRelease } = renderToast()

    await userEvent.click(screen.getByRole('button', { name: 'Share…' }))
    expect(onHold).toHaveBeenCalled()
    screen.getByRole('button', { name: 'Close' }).focus()
    expect(onRelease).not.toHaveBeenCalled()

    screen.getByRole('button', { name: 'Elsewhere' }).focus()
    expect(onRelease).toHaveBeenCalledTimes(1)
  })
})
