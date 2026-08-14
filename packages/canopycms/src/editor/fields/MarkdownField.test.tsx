import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MarkdownField } from './MarkdownField'

// Preload the chunk MarkdownField's React.lazy() imports.
//
// The mount assertion below is about WHETHER the real editor mounts, not how
// fast: without this it also silently measures how long vitest takes to
// transform @mdxeditor/editor, because the lazy promise only settles once
// that work is done. That made the test fail under full-suite contention
// while passing whenever this project ran alone -- a real defect in the test,
// not flakiness to paper over with a longer timeout.
//
// Importing the same specifier statically puts the module in vitest's
// registry during THIS file's import phase, so React.lazy's import()
// resolves from cache on the first microtask and the assertion measures only
// the product. Same specifier as MarkdownField.tsx uses, deliberately -- a
// different one would warm nothing.
import '@mdxeditor/editor'

vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

describe('MarkdownField', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the fallback textarea while the MDXEditor chunk loads', () => {
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <MarkdownField value="hello" onChange={() => {}} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    // Synchronous first render, before Suspense resolves the lazy import -
    // the readonly fallback textarea is what's on screen.
    expect(screen.getByPlaceholderText('Loading markdown editor...')).toBeTruthy()
  })

  /**
   * Full end-to-end coverage of the MDX image dialog (clicking the toolbar's
   * icon-only "Insert Image" button, which mdxeditor renders via a Radix
   * Tooltip trigger with no static accessible name/role testing-library can
   * target) is impractical here - see the PR report. This test instead
   * confirms the integration point that IS reliably observable: once the
   * real MDXEditor mounts, our custom `MdxImageDialog` (not the stock one)
   * is wired in as a composer child via `imagePlugin({ ImageDialog })`.
   * MdxImageDialog's own tabs/save/cancel behavior is unit-tested directly
   * (with plain props) in MdxImageDialog.test.tsx.
   */
  it('mounts the real MDXEditor with our custom image dialog wired in', async () => {
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <MarkdownField value="hello" onChange={() => {}} />
        </Wrapper>
      </CanopyCMSProvider>,
    )

    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toBeTruthy())
    expect(screen.getByTestId('mdx-image-dialog')).toBeTruthy()
    // The custom InsertEntryLink toolbar button is on the same toolbar,
    // confirming the toolbar itself rendered (not just an editor shell).
    expect(screen.getByTestId('insert-entry-link-button')).toBeTruthy()
  })
})
