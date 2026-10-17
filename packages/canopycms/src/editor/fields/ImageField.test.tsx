import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import type { AssetRecord } from '../../api'
import type { ImageFieldValue } from '../../config'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { AssetContextProvider } from '../context'
import { ImageField, type ImageFieldProps } from './ImageField'
import type { CropRect } from '../../assets/transform-directives'

// Mock CropStep - its own percentage->rect math is unit-tested in
// crop-math.test.ts, and its crop UI can't meaningfully render in
// jsdom (no real image load/measurement). Stub it down to a single button
// that calls onConfirm with a fixed rect, so ImageField's own logic (when to
// open the crop step, what it commits on confirm) is exercised in isolation.
vi.mock('../media/CropStep', () => ({
  CropStep: (props: {
    opened: boolean
    imageSrc: string
    aspect?: number
    onConfirm: (rect: CropRect) => void
    onClose: () => void
  }) =>
    props.opened ? (
      <div data-testid="mock-crop-step">
        <span data-testid="mock-crop-step-image-src">{props.imageSrc}</span>
        <span data-testid="mock-crop-step-aspect">{String(props.aspect)}</span>
        <button
          data-testid="mock-crop-confirm-wide"
          onClick={() => props.onConfirm({ x: 0, y: 0.25, w: 1, h: 0.5 })}
        >
          Confirm wide crop
        </button>
        <button
          data-testid="mock-crop-confirm"
          onClick={() => props.onConfirm({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 })}
        >
          Confirm crop
        </button>
        <button data-testid="mock-crop-cancel" onClick={props.onClose}>
          Cancel crop
        </button>
      </div>
    ) : null,
}))

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

const catAsset: AssetRecord = {
  hash32: 'a'.repeat(32),
  filename: 'cat.png',
  slug: 'cat',
  ext: 'png',
  mime: 'image/png',
  size: 1024,
  width: 400,
  height: 300,
  kind: 'raster',
  uploadedAt: '2024-01-01T00:00:00.000Z',
  src: `/assets/t/orig/${'a'.repeat(32)}/cat.png`,
}

function StatefulImageField(props: Partial<ImageFieldProps>) {
  const [value, setValue] = useState<ImageFieldValue | undefined>(props.value)
  return (
    <>
      <ImageField
        dataCanopyField="hero"
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next)
          props.onChange?.(next)
        }}
      />
      <pre data-testid="field-value">{JSON.stringify(value ?? null)}</pre>
    </>
  )
}

describe('ImageField', () => {
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

  const renderField = (props: Partial<ImageFieldProps> = {}) => {
    const Wrapper = wrapper
    return render(
      <CanopyCMSProvider>
        <Wrapper>
          <StatefulImageField {...props} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
  }

  it('renders the empty state with a dropzone and a Browse library button', () => {
    renderField()
    expect(screen.getByTestId('image-field-dropzone-hero')).toBeTruthy()
    expect(screen.getByTestId('image-field-browse-library-hero')).toBeTruthy()
    expect(screen.queryByTestId('image-field-alt-hero')).toBeNull()
  })

  it('restricts the dropzone to image mime types - PDF is excluded', () => {
    renderField()
    const dropzone = screen.getByTestId('image-field-dropzone-hero')
    const input = dropzone.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.accept).not.toContain('application/pdf')
    expect(input.accept).toContain('image/png')
  })

  it('picking from the library (no aspect) commits the value immediately', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderField()
    fireEvent.click(screen.getByTestId('image-field-browse-library-hero'))

    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
      expect(state).toEqual({ src: catAsset.src, alt: '', width: 400, height: 300 })
    })
    // No aspect configured - the crop step never opens.
    expect(screen.queryByTestId('mock-crop-step')).toBeNull()
  })

  it('picking from the library with aspect configured opens the crop step before committing', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderField({ aspect: '16:9' })
    fireEvent.click(screen.getByTestId('image-field-browse-library-hero'))

    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    const cropStep = await screen.findByTestId('mock-crop-step')
    expect(cropStep).toBeTruthy()
    // Value has not committed yet.
    expect(JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')).toBeNull()
    // The crop source loads through the authenticated route; the stored src stays root-relative.
    expect(screen.getByTestId('mock-crop-step-image-src').textContent).toBe(
      `/api/canopycms/assets/raw${catAsset.src}`,
    )

    fireEvent.click(screen.getByTestId('mock-crop-confirm'))

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
      expect(state).toEqual({
        src: catAsset.src,
        alt: '',
        width: 400,
        height: 300,
        crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      })
    })
  })

  it('canceling the crop step leaves the value uncommitted', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderField({ aspect: '1:1' })
    fireEvent.click(screen.getByTestId('image-field-browse-library-hero'))
    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    await screen.findByTestId('mock-crop-step')
    fireEvent.click(screen.getByTestId('mock-crop-cancel'))

    await waitFor(() => expect(screen.queryByTestId('mock-crop-step')).toBeNull())
    expect(JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')).toBeNull()
  })

  it('filled state renders a thumbnail, alt input, and Replace/Remove/Crop controls', () => {
    renderField({
      value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 },
      aspect: '4:3',
    })

    expect((screen.getByTestId('image-field-alt-hero') as HTMLInputElement).value).toBe('A cat')
    expect(screen.getByTestId('image-field-replace-hero')).toBeTruthy()
    expect(screen.getByTestId('image-field-remove-hero')).toBeTruthy()
    expect(screen.getByTestId('image-field-crop-hero')).toBeTruthy()
  })

  it('loads the cropped preview through the authenticated route under the basePath', () => {
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <AssetContextProvider basePath="/p">
            <StatefulImageField
              value={{
                src: catAsset.src,
                alt: 'A cat',
                width: 400,
                height: 300,
                crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
              }}
            />
          </AssetContextProvider>
        </Wrapper>
      </CanopyCMSProvider>,
    )

    expect(screen.getByAltText('A cat').getAttribute('src')).toBe(
      `/p/api/canopycms/assets/raw/assets/t/c=0.1000:0.2000:0.5000:0.2500,w=320/${catAsset.hash32}/cat.png`,
    )
  })

  describe('Crop button', () => {
    const SVG_REASON = "SVG images can't be cropped."
    const STORE_REASON =
      'Crop works on media-library images. Replace this file with a library copy to crop it.'
    const libraryValue = { src: catAsset.src, alt: 'A cat', width: 400, height: 300 }

    const expectReasonOnFocus = async (reason: string) => {
      const crop = screen.getByTestId('image-field-crop-hero')
      expect(crop.getAttribute('aria-disabled')).toBe('true')
      act(() => crop.focus())
      expect(await screen.findByText(reason)).toBeTruthy()
      fireEvent.click(crop)
      expect(screen.queryByTestId('mock-crop-step')).toBeNull()
    }

    it('is enabled for a library raster, with or without aspect, and opens the crop step', () => {
      renderField({ value: libraryValue })
      const crop = screen.getByTestId('image-field-crop-hero')
      expect(crop.getAttribute('aria-disabled')).toBeNull()
      fireEvent.click(crop)
      expect(screen.getByTestId('mock-crop-step-aspect').textContent).toBe('undefined')
    })

    it('is disabled with the library reason for a raster outside the asset store', async () => {
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <AssetContextProvider basePath="/p">
              <StatefulImageField value={{ src: '/people/x.png', alt: 'A person' }} aspect="1:1" />
            </AssetContextProvider>
          </Wrapper>
        </CanopyCMSProvider>,
      )
      expect(screen.getByAltText('A person').getAttribute('src')).toBe('/people/x.png')
      await expectReasonOnFocus(STORE_REASON)
    })

    it('is disabled with the SVG reason for an svg outside the asset store', async () => {
      renderField({ value: { src: '/logos/x.svg', alt: 'A logo' } })
      await expectReasonOnFocus(SVG_REASON)
    })

    it('is disabled with the SVG reason for an svg in the asset store', async () => {
      const hash = 'b'.repeat(32)
      renderField({ value: { src: `/assets/${hash}/logo.svg`, alt: 'A logo' } })
      await expectReasonOnFocus(SVG_REASON)
    })

    it('is absent on a read-only form, whatever the image', () => {
      renderField({ value: libraryValue, readOnly: true })
      expect(screen.queryByTestId('image-field-crop-hero')).toBeNull()
      expect(screen.queryByTestId('image-field-replace-hero')).toBeNull()
      expect(screen.queryByTestId('image-field-remove-hero')).toBeNull()
    })
  })

  describe('crop shape', () => {
    const pickCatInto = async () => {
      mockClient.assets.list.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { assets: [catAsset] },
      })
      fireEvent.click(screen.getByTestId('image-field-browse-library-hero'))
      fireEvent.click(await screen.findByTestId(`asset-card-${catAsset.hash32}`))
    }

    it('without aspect, Crop is free-form and stores a rectangle of any ratio', async () => {
      renderField({ value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 } })
      fireEvent.click(screen.getByTestId('image-field-crop-hero'))
      expect(screen.getByTestId('mock-crop-step-aspect').textContent).toBe('undefined')

      fireEvent.click(screen.getByTestId('mock-crop-confirm-wide'))

      await waitFor(() => {
        const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
        expect(state.crop).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 })
        expect(state.width).toBe(400)
        expect(state.height).toBe(300)
      })
    })

    it('with aspect, Crop locks the ratio and a pick still crops before committing', async () => {
      renderField({ aspect: '16:9' })
      await pickCatInto()
      expect((await screen.findByTestId('mock-crop-step-aspect')).textContent).toBe(String(16 / 9))
    })

    it('with aspect, a picked svg commits without a crop step', async () => {
      const hash = 'c'.repeat(32)
      const svgAsset: AssetRecord = {
        ...catAsset,
        hash32: hash,
        filename: 'logo.svg',
        slug: 'logo',
        ext: 'svg',
        mime: 'image/svg+xml',
        kind: 'svg',
        src: `/assets/${hash}/logo.svg`,
      }
      mockClient.assets.list.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { assets: [svgAsset] },
      })
      renderField({ aspect: '1:1' })
      fireEvent.click(screen.getByTestId('image-field-browse-library-hero'))
      fireEvent.click(await screen.findByTestId(`asset-card-${hash}`))

      await waitFor(() => {
        const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
        expect(state?.src).toBe(svgAsset.src)
        expect(state?.crop).toBeUndefined()
      })
      expect(screen.queryByTestId('mock-crop-step')).toBeNull()
    })
  })

  describe('card', () => {
    it('keeps Replace, Crop and Remove, the thumbnail and the alt text inside one labelled group', () => {
      renderField({
        label: 'Hero image',
        value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 },
      })
      const group = screen.getByRole('group', { name: 'Hero image' })
      for (const id of ['replace', 'crop', 'remove', 'alt']) {
        expect(group.contains(screen.getByTestId(`image-field-${id}-hero`))).toBe(true)
      }
      expect(group.contains(screen.getByAltText('A cat'))).toBe(true)
    })

    it('puts the actions in the label row, above the thumbnail', () => {
      renderField({
        label: 'Hero image',
        value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 },
      })
      const actions = screen.getByTestId('image-field-replace-hero')
      const thumbnail = screen.getByAltText('A cat')
      expect(
        actions.compareDocumentPosition(thumbnail) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('frames the empty and read-only states as a group named by the label', () => {
      renderField({ label: 'Hero image' })
      expect(screen.getByRole('group', { name: 'Hero image' })).toBeTruthy()
      cleanup()
      renderField({ label: 'Hero image', readOnly: true })
      const group = screen.getByRole('group', { name: 'Hero image' })
      expect(group.contains(screen.getByTestId('image-field-empty-hero'))).toBe(true)
    })
  })

  it('editing the alt input updates only alt, preserving src/width/height', () => {
    renderField({ value: { src: catAsset.src, alt: '', width: 400, height: 300 } })

    fireEvent.change(screen.getByTestId('image-field-alt-hero'), {
      target: { value: 'A fluffy cat' },
    })

    const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
    expect(state).toEqual({ src: catAsset.src, alt: 'A fluffy cat', width: 400, height: 300 })
  })

  it('wires the alt sub-path error onto the alt input', () => {
    renderField({
      value: { src: catAsset.src, alt: '', width: 400, height: 300 },
      errors: { alt: 'Image alt text is required' },
    })
    expect(screen.getByText('Image alt text is required')).toBeTruthy()
  })

  it('Remove clears the value back to the empty state', () => {
    renderField({ value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 } })

    fireEvent.click(screen.getByTestId('image-field-remove-hero'))

    expect(JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')).toBeNull()
    expect(screen.getByTestId('image-field-dropzone-hero')).toBeTruthy()
  })

  it('Replace reopens the picker without clearing the current value first', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderField({
      value: { src: '/assets/t/orig/existing/old.png', alt: 'Old', width: 1, height: 1 },
    })

    fireEvent.click(screen.getByTestId('image-field-replace-hero'))
    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
      // Replacing preserves the existing alt text rather than wiping it -
      // it often still describes the new image, and the editor can edit it.
      expect(state).toEqual({ src: catAsset.src, alt: 'Old', width: 400, height: 300 })
    })
  })

  it('shows a "Preview unavailable" fallback when the image fails to load, matching AssetCard', () => {
    renderField({ value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 } })

    const img = screen.getByRole('img')
    fireEvent.error(img)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId('image-field-preview-fallback-hero')).toBeTruthy()
    expect(screen.getByText('Preview unavailable')).toBeTruthy()
  })

  it('still renders the alt input and Replace/Remove controls when the preview fails', () => {
    renderField({ value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 } })

    fireEvent.error(screen.getByRole('img'))

    expect((screen.getByTestId('image-field-alt-hero') as HTMLInputElement).value).toBe('A cat')
    expect(screen.getByTestId('image-field-replace-hero')).toBeTruthy()
    expect(screen.getByTestId('image-field-remove-hero')).toBeTruthy()
  })

  it('resets the preview error state when the src changes (e.g. after Replace)', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderField({
      value: { src: '/assets/t/orig/existing/old.png', alt: 'Old', width: 1, height: 1 },
    })
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByTestId('image-field-preview-fallback-hero')).toBeTruthy()

    fireEvent.click(screen.getByTestId('image-field-replace-hero'))
    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    await waitFor(() => {
      expect(screen.queryByTestId('image-field-preview-fallback-hero')).toBeNull()
      expect(screen.getByRole('img')).toBeTruthy()
    })
  })

  it('picking into an empty field yields empty alt text (nothing to preserve)', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderField()
    fireEvent.click(screen.getByTestId('image-field-browse-library-hero'))
    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('field-value').textContent ?? 'null')
      expect(state).toEqual({ src: catAsset.src, alt: '', width: 400, height: 300 })
    })
  })
})
