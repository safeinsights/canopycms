import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { RetryToastMessage } from './RetryToastMessage'

describe('RetryToastMessage', () => {
  it('shows what failed and retries from its button', async () => {
    const onRetry = vi.fn()
    render(
      <MantineProvider>
        <RetryToastMessage message="Couldn't load the branches." onRetry={onRetry} />
      </MantineProvider>,
    )
    expect(screen.getByText("Couldn't load the branches.")).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('labels its button with actionLabel instead of Retry, and acts on a click of it', async () => {
    const onRetry = vi.fn()
    render(
      <MantineProvider>
        <RetryToastMessage
          message="This entry was deleted."
          actionLabel="Save as new entry"
          onRetry={onRetry}
        />
      </MantineProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save as new entry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
