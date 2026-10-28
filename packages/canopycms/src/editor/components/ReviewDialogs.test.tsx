import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteNotSavedMessage, RequestChangesForm } from './ReviewDialogs'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderForm = (initialNote?: string) =>
  render(
    <MantineProvider>
      <RequestChangesForm
        branchName="feature/docs"
        hasPullRequest
        initialNote={initialNote}
        onNoteChange={() => {}}
      />
    </MantineProvider>,
  )

describe('RequestChangesForm caret', () => {
  it('lands after a prefilled note on first focus', () => {
    renderForm('Fix the intro.')
    const field = screen.getByTestId('request-changes-note') as HTMLTextAreaElement
    // A fresh textarea puts the caret at the start; the dialog's focus trap focuses it.
    field.setSelectionRange(0, 0)
    act(() => field.focus())
    expect(field.selectionStart).toBe('Fix the intro.'.length)
    expect(field.selectionEnd).toBe('Fix the intro.'.length)
  })

  it('leaves the caret where the reviewer put it on later focus', () => {
    renderForm('Fix the intro.')
    const field = screen.getByTestId('request-changes-note') as HTMLTextAreaElement
    act(() => field.focus())
    field.setSelectionRange(3, 3)
    act(() => field.blur())
    act(() => field.focus())
    expect(field.selectionStart).toBe(3)
  })

  it('starts an empty note with the caret at the start, which is also its end', () => {
    renderForm()
    const field = screen.getByTestId('request-changes-note') as HTMLTextAreaElement
    act(() => field.focus())
    expect(field.selectionStart).toBe(0)
  })
})

describe('NoteNotSavedMessage', () => {
  it('announces a copy, after the status region is already on the page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(
      <MantineProvider>
        <NoteNotSavedMessage message="Not saved." note="Fix the intro." />
      </MantineProvider>,
    )
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy note' }))
    })

    expect(writeText).toHaveBeenCalledWith('Fix the intro.')
    expect(screen.getByRole('status').textContent).toBe('Note copied')
  })
})
