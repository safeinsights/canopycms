import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EditorCrashBoundary, entriesUrl } from './EditorCrashScreen'
import { mockConsole, type MockConsole } from '../../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../../test-utils/render-errors'

const Thrower: React.FC<{ error: Error }> = ({ error }) => {
  throw error
}

describe('EditorCrashBoundary', () => {
  let consoleSpy: MockConsole
  let unsilence: () => void
  const writeText = vi.fn(async (_text: string) => {})

  beforeEach(() => {
    consoleSpy = mockConsole()
    unsilence = silenceReportedRenderErrors()
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  afterEach(() => {
    unsilence()
    consoleSpy.restore()
  })

  it('replaces a crashed editor with Reload, Back to entries and Copy error details', () => {
    render(
      <EditorCrashBoundary>
        <Thrower error={new Error('boom')} />
      </EditorCrashBoundary>,
    )

    expect(screen.getByTestId('editor-crash-screen').textContent).toContain(
      'The editor stopped working',
    )
    for (const name of ['Reload', 'Back to entries', 'Copy error details']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(consoleSpy).toHaveErrored('[canopycms] editor error caught (editor)')
  })

  it('copies error details with paths and tokens redacted', async () => {
    const error = new Error(
      'cannot read /mnt/efs/workspace/main/content.json with ghp_abcdefghijklmnop1234',
    )
    error.stack = `${error.message}\n    at render (file:///Users/bob/site/node_modules/x.js:1:2)`
    render(
      <EditorCrashBoundary>
        <Thrower error={error} />
      </EditorCrashBoundary>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('CanopyCMS editor error')
    expect(copied).toContain('Caught by: editor')
    expect(copied).toContain('Error: Error: cannot read <path> with ***')
    expect(copied).toContain('Component stack:')
    expect(copied).not.toContain('/mnt/efs')
    expect(copied).not.toContain('/Users/bob')
    expect(copied).not.toContain('ghp_')
  })
})

describe('entriesUrl', () => {
  it('asks for no entry and keeps the branch', () => {
    expect(entriesUrl('https://site.test/edit?branch=feature&entry=content%2Fposts%2Fhello')).toBe(
      'https://site.test/edit?branch=feature&entry=',
    )
    expect(entriesUrl('https://site.test/edit')).toBe('https://site.test/edit?entry=')
  })
})
