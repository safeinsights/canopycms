import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { NoEditPermissionNotice, type NoEditPermissionNoticeProps } from './NoEditPermissionNotice'

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
})

const renderNotice = (props: Partial<NoEditPermissionNoticeProps> = {}) =>
  render(
    <MantineProvider>
      <NoEditPermissionNotice entryPath="docs/guide" {...props} />
    </MantineProvider>,
  )

const noticeText = () => screen.getByTestId('no-edit-permission-notice').textContent

describe('NoEditPermissionNotice', () => {
  afterEach(cleanup)

  it('says the protected base branch is read-only and to switch branches', () => {
    renderNotice({
      branchName: 'main',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchStatus: 'editing',
    })

    expect(noticeText()).toBe(
      '"main" is the protected base branch, so its content is read-only. Create or switch to another branch to edit.',
    )
  })

  it('prefers the base-branch reason over a status lock', () => {
    renderNotice({
      branchName: 'main',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchStatus: 'submitted',
    })

    expect(noticeText()).toContain('protected base branch')
  })

  it('says a submitted branch is locked and can be withdrawn', () => {
    renderNotice({ branchName: 'feature', branchWriteBlocked: true, branchStatus: 'submitted' })

    expect(noticeText()).toBe(
      '"feature" is submitted for review and locked for edits. Withdraw it to resume editing.',
    )
  })

  it('names any other locked status', () => {
    renderNotice({ branchName: 'feature', branchWriteBlocked: true, branchStatus: 'approved' })

    expect(noticeText()).toBe('"feature" is approved, so its content is read-only.')
  })

  it('names the entry path and Manage Permissions when the branch is writable', () => {
    renderNotice({ branchName: 'feature', branchWriteBlocked: false, branchStatus: 'editing' })

    expect(noticeText()).toBe(
      'You don\'t have edit access to "docs/guide". Ask a CanopyCMS admin to grant it in Manage Permissions.',
    )
  })

  it('falls back to the permission message when branch details are unknown', () => {
    renderNotice({ branchWriteBlocked: true })

    expect(noticeText()).toContain('Manage Permissions')
  })
})
