import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { CropStep } from './CropStep'

// jsdom never lays an image out, so `load` reports no size. The step seeds its box from the
// displayed size, so give every image a 400x300 frame.
const IMAGE_SIZE = { width: 400, height: 300 }

describe('CropStep', () => {
  beforeEach(() => {
    vi.spyOn(HTMLImageElement.prototype, 'width', 'get').mockReturnValue(IMAGE_SIZE.width)
    vi.spyOn(HTMLImageElement.prototype, 'height', 'get').mockReturnValue(IMAGE_SIZE.height)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const renderStep = (props: Partial<React.ComponentProps<typeof CropStep>> = {}) => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const utils = render(
      <CanopyCMSProvider>
        <CropStep
          opened
          onClose={onClose}
          imageSrc="/assets/t/orig/aaaa/cat.png"
          onConfirm={onConfirm}
          {...props}
        />
      </CanopyCMSProvider>,
    )
    return { ...utils, onConfirm, onClose }
  }

  const loadImage = () => fireEvent.load(screen.getByRole('presentation', { hidden: true }))
  const apply = () => screen.getByTestId('crop-step-apply') as HTMLButtonElement

  it('disables Apply crop until the image has loaded', () => {
    renderStep()
    expect(apply().disabled).toBe(true)

    loadImage()
    expect(apply().disabled).toBe(false)
  })

  it('free-form: opens with a box covering most of the frame and confirms that rectangle', () => {
    const { onConfirm } = renderStep()
    loadImage()
    fireEvent.click(apply())

    expect(onConfirm).toHaveBeenCalledWith({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 })
  })

  it('locked: opens with a centred box of the field ratio', () => {
    const { onConfirm } = renderStep({ aspect: 2 })
    loadImage()
    fireEvent.click(apply())

    // 400x300 frame, ratio 2:1: 90% of the width is 360px, so 180px (0.6) tall, centred.
    expect(onConfirm).toHaveBeenCalledWith({ x: 0.05, y: 0.2, w: 0.9, h: 0.6 })
  })

  it('re-cropping opens on the stored rectangle', () => {
    const stored = { x: 0.1, y: 0.2, w: 0.5, h: 0.25 }
    const { onConfirm } = renderStep({ initialCrop: stored })
    loadImage()
    fireEvent.click(apply())

    expect(onConfirm).toHaveBeenCalledWith(stored)
  })

  it('Cancel calls onClose without confirming', () => {
    const { onConfirm, onClose } = renderStep()
    fireEvent.click(screen.getByText('Cancel'))

    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders nothing crop-related when closed', () => {
    renderStep({ opened: false })
    expect(screen.queryByTestId('crop-step-apply')).toBeNull()
  })
})
