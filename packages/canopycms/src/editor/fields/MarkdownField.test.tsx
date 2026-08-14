import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MarkdownField } from './MarkdownField'

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

    // Explicit timeout, same reason as FormRenderer.test.tsx's rich-text
    // mount test: this waits on a real dynamic import of the MDXEditor chunk,
    // so the 1s default measures machine load rather than the product. Red on
    // a full-suite run (both vitest projects contending), green whenever this
    // project ran alone.
    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toBeTruthy(), {
      timeout: 15_000,
    })
    expect(screen.getByTestId('mdx-image-dialog')).toBeTruthy()
    // The custom InsertEntryLink toolbar button is on the same toolbar,
    // confirming the toolbar itself rendered (not just an editor shell).
    expect(screen.getByTestId('insert-entry-link-button')).toBeTruthy()
  }, 20_000)
})
