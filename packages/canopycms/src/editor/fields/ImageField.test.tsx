import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import type { AssetRecord } from '../../api'
import type { ImageFieldValue } from '../../config'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { ImageField, type ImageFieldProps } from './ImageField'
import type { CropRect } from '../../assets/transform-directives'

// Mock CropStep - its own percentage->rect math is unit-tested in
// crop-math.test.ts, and its react-easy-crop UI can't meaningfully render in
// jsdom (no real image load/measurement). Stub it down to a single button
// that calls onConfirm with a fixed rect, so ImageField's own logic (when to
// open the crop step, what it commits on confirm) is exercised in isolation.
vi.mock('../media/CropStep', () => ({
  CropStep: (props: {
    opened: boolean
    imageSrc: string
    onConfirm: (rect: CropRect) => void
    onClose: () => void
  }) =>
    props.opened ? (
      <div data-testid="mock-crop-step">
        <span data-testid="mock-crop-step-image-src">{props.imageSrc}</span>
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
    expect(screen.getByTestId('mock-crop-step-image-src').textContent).toBe(catAsset.src)

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

  it('omits the Crop button when the field has no aspect configured', () => {
    renderField({ value: { src: catAsset.src, alt: 'A cat', width: 400, height: 300 } })
    expect(screen.queryByTestId('image-field-crop-hero')).toBeNull()
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
      expect(state).toEqual({ src: catAsset.src, alt: '', width: 400, height: 300 })
    })
  })
})
