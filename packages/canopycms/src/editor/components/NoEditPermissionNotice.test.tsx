import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { NoEditPermissionNotice } from './NoEditPermissionNotice'

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

const renderNotice = () =>
  render(
    <MantineProvider>
      <NoEditPermissionNotice entryPath="docs/guide" />
    </MantineProvider>,
  )

const noticeText = () => screen.getByTestId('no-edit-permission-notice').textContent

describe('NoEditPermissionNotice', () => {
  afterEach(cleanup)

  // canEdit is false only when a path rule denies edit, so the notice names that and whom to
  // ask; a locked or protected branch is reported by the header banner instead.
  it('names the entry path, whom to ask, and where to grant access', () => {
    renderNotice()

    expect(noticeText()).toBe(
      'You don\'t have edit access to "docs/guide". Ask a CanopyCMS admin to grant it in Manage Permissions.',
    )
  })
})
