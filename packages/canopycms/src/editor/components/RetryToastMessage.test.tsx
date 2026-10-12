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
})
