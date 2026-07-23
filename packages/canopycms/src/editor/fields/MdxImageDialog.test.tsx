import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import type { AssetRecord } from '../../api'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MdxImageDialog, type MdxImageDialogState } from './MdxImageDialog'

// This file exercises MdxImageDialog directly via plain props - it imports
// nothing at runtime from `@mdxeditor/editor` (only `import type`, erased at
// build time), so no mdxeditor/gurx mocking is needed. The realm-cell bridge
// that supplies `state`/`onSave`/`onClose` in the real editor is defined
// inline in MarkdownField.tsx's lazy factory and is not separately unit-
// tested here (mdxeditor's cell wiring can't be exercised without mounting
// the full MDXEditor - see the PR report for why that's out of scope).
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

const inactiveState: MdxImageDialogState = { type: 'inactive' }
const newState: MdxImageDialogState = { type: 'new' }

const catAsset: AssetRecord = {
  hash32: 'a'.repeat(32),
  filename: 'cat.png',
  slug: 'cat',
  ext: 'png',
  mime: 'image/png',
  size: 1024,
  kind: 'raster',
  uploadedAt: '2024-01-01T00:00:00.000Z',
  src: `/assets/t/orig/${'a'.repeat(32)}/cat.png`,
}

describe('MdxImageDialog', () => {
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

  const renderDialog = (props: Partial<React.ComponentProps<typeof MdxImageDialog>> = {}) => {
    const Wrapper = wrapper
    const onSave = vi.fn()
    const onClose = vi.fn()
    const utils = render(
      <CanopyCMSProvider>
        <Wrapper>
          <MdxImageDialog state={newState} onSave={onSave} onClose={onClose} {...props} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    return { ...utils, onSave, onClose }
  }

  it('defaults to the Upload tab for a new insert', () => {
    renderDialog()
    expect(screen.getByTestId('mdx-image-dialog-dropzone')).toBeTruthy()
  })

  it('restricts the upload dropzone to image mime types - PDF is excluded', () => {
    renderDialog()
    const dropzone = screen.getByTestId('mdx-image-dialog-dropzone')
    const input = dropzone.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.accept).not.toContain('application/pdf')
    expect(input.accept).toContain('image/png')
  })

  it('defaults to the By URL tab when editing an existing image, pre-filled', () => {
    const editingState: MdxImageDialogState = {
      type: 'editing',
      nodeKey: 'node-1',
      initialValues: { src: 'https://example.com/existing.png', altText: 'Existing alt' },
    }
    renderDialog({ state: editingState })

    expect((screen.getByTestId('mdx-image-dialog-alt') as HTMLInputElement).value).toBe(
      'Existing alt',
    )
    expect((screen.getByTestId('mdx-image-dialog-url') as HTMLInputElement).value).toBe(
      'https://example.com/existing.png',
    )
  })

  it('By URL tab: entering a URL and clicking Insert saves with the current alt text', async () => {
    const { onSave, onClose } = renderDialog()
    const user = userEvent.setup()

    await user.type(screen.getByTestId('mdx-image-dialog-alt'), 'A cat')
    await user.click(screen.getByTestId('mdx-image-dialog-tab-url'))
    await user.type(screen.getByTestId('mdx-image-dialog-url'), 'https://example.com/cat.png')
    fireEvent.click(screen.getByTestId('mdx-image-dialog-url-submit'))

    expect(onSave).toHaveBeenCalledWith({
      src: 'https://example.com/cat.png',
      altText: 'A cat',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('Insert is disabled until a URL is entered', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('mdx-image-dialog-tab-url'))
    expect((screen.getByTestId('mdx-image-dialog-url-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('From library tab: picking an asset saves its src and closes', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    const { onSave, onClose } = renderDialog()

    fireEvent.click(screen.getByTestId('mdx-image-dialog-tab-library'))
    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    expect(onSave).toHaveBeenCalledWith({ src: catAsset.src, altText: '' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Cancel closes without saving', () => {
    const { onSave, onClose } = renderDialog()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('renders no dialog content (Mantine Modal closed) when inactive', () => {
    renderDialog({ state: inactiveState })
    // Mantine's Modal keeps an empty root node mounted for exit transitions
    // even when closed, but renders none of its children - so content
    // (not the root testid) is the right thing to assert absent.
    expect(screen.queryByTestId('mdx-image-dialog-dropzone')).toBeNull()
    expect(screen.queryByTestId('mdx-image-dialog-alt')).toBeNull()
  })

  it('resets alt/url/tab state between successive opens', async () => {
    const Wrapper = wrapper
    const { rerender } = renderDialog({ state: inactiveState })
    rerender(
      <CanopyCMSProvider>
        <Wrapper>
          <MdxImageDialog
            state={{
              type: 'editing',
              nodeKey: 'node-1',
              initialValues: { src: 'https://example.com/a.png', altText: 'Alt A' },
            }}
            onSave={vi.fn()}
            onClose={vi.fn()}
          />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    await waitFor(() =>
      expect((screen.getByTestId('mdx-image-dialog-alt') as HTMLInputElement).value).toBe('Alt A'),
    )

    rerender(
      <CanopyCMSProvider>
        <Wrapper>
          <MdxImageDialog state={newState} onSave={vi.fn()} onClose={vi.fn()} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    await waitFor(() =>
      expect((screen.getByTestId('mdx-image-dialog-alt') as HTMLInputElement).value).toBe(''),
    )
    expect(screen.getByTestId('mdx-image-dialog-dropzone')).toBeTruthy()
  })
})
