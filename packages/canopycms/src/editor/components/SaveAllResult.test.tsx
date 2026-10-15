import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { notifications } from '@mantine/notifications'
import {
  SaveAllResultMessage,
  clearSaveAllResult,
  settleSaveAllEntry,
  showSaveAllResult,
} from './SaveAllResult'
import { SAVE_ALL_REASONS, type SaveAllFailure, type SaveAllResult } from '../hooks/save-all'
import { CanopyCMSProvider } from '../theme'
import { unsafeAsLogicalPath } from '../../paths/test-utils'

vi.mock('@mantine/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantine/notifications')>()),
  notifications: { show: vi.fn(), hide: vi.fn(), update: vi.fn() },
}))

const failure = (label: string, kind: SaveAllFailure['kind']): SaveAllFailure => ({
  contentId: label,
  label,
  path: unsafeAsLogicalPath(`content/${label}`),
  kind,
  reason: kind === 'error' ? SAVE_ALL_REASONS.failed : SAVE_ALL_REASONS.staleBase,
})

const result = (...failed: SaveAllFailure[]): SaveAllResult => ({
  branch: 'b',
  total: failed.length + 1,
  saved: [{ contentId: 'ok', label: 'ok', path: unsafeAsLogicalPath('content/ok') }],
  failed,
})

const actions = { onOpenEntry: vi.fn(), onRetry: vi.fn() }

afterEach(() => {
  cleanup()
  clearSaveAllResult()
  vi.clearAllMocks()
})

describe('SaveAllResultMessage', () => {
  const renderMessage = (r: SaveAllResult) =>
    render(
      <CanopyCMSProvider>
        <SaveAllResultMessage result={r} {...actions} />
      </CanopyCMSProvider>,
    )

  it('marks each failure by its own severity, not colour alone', () => {
    renderMessage(result(failure('a', 'conflict'), failure('b', 'error')))
    const [warning, error] = screen.getAllByTestId('save-all-failure')
    expect(within(warning).getByText('Warning:', { exact: false })).toBeTruthy()
    expect(within(error).getByText('Error:', { exact: false })).toBeTruthy()
  })

  it('offers Try again only when a retry can pass', () => {
    renderMessage(result(failure('a', 'conflict'), failure('b', 'unanswered')))
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    cleanup()
    renderMessage(result(failure('a', 'conflict'), failure('b', 'error')))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('offers Try again for a conflict refused only for now', () => {
    renderMessage(result({ ...failure('a', 'conflict'), retryable: true }))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('showSaveAllResult', () => {
  it('is yellow when nothing failed for good, else red', () => {
    showSaveAllResult(result(failure('a', 'conflict')), actions)
    expect(notifications.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ color: 'yellow', autoClose: false }),
    )
    showSaveAllResult(result(failure('a', 'conflict'), failure('b', 'error')), actions)
    expect(notifications.show).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'red' }))
  })

  it('takes an entry settled elsewhere out, and the toast down with the last one', () => {
    showSaveAllResult(result(failure('a', 'conflict'), failure('b', 'error')), actions)
    settleSaveAllEntry('b')
    expect(notifications.update).toHaveBeenLastCalledWith(
      // The settled entry leaves the count too.
      expect.objectContaining({ title: '1 of 2 entries not saved', color: 'yellow' }),
    )
    settleSaveAllEntry('unrelated')
    expect(notifications.update).toHaveBeenCalledTimes(1)
    settleSaveAllEntry('a')
    expect(notifications.hide).toHaveBeenLastCalledWith('canopy-save-all-result')
  })

  it("doesn't claim an entry whose save got no answer was not saved", () => {
    showSaveAllResult(result(failure('a', 'unanswered')), actions)
    expect(notifications.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '1 of 2 entries may not have saved' }),
    )
  })

  it('says so when the run found nothing left to save', () => {
    showSaveAllResult({ branch: 'b', total: 0, saved: [], failed: [] }, actions)
    expect(notifications.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'No changes to save' }),
    )
  })
})
