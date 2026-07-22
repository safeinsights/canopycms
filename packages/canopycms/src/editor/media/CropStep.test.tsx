import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { CropStep } from './CropStep'

// react-easy-crop measures real image/container dimensions via
// ResizeObserver + image load events, none of which jsdom drives - stub it
// down to a button that fires onCropComplete with a fixed percentage Area,
// so CropStep's own wiring (Apply disabled until a selection exists, the
// confirmed rect matches crop-math.ts's conversion) is testable without a
// real image.
vi.mock('react-easy-crop', () => ({
  __esModule: true,
  default: ({
    onCropComplete,
  }: {
    onCropComplete?: (area: { x: number; y: number; width: number; height: number }) => void
  }) => (
    <button
      data-testid="mock-cropper"
      onClick={() => onCropComplete?.({ x: 25, y: 25, width: 50, height: 50 })}
    >
      Mock Cropper
    </button>
  ),
}))

describe('CropStep', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
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
          aspect={16 / 9}
          onConfirm={onConfirm}
          {...props}
        />
      </CanopyCMSProvider>,
    )
    return { ...utils, onConfirm, onClose }
  }

  it('disables Apply crop until a selection is made', () => {
    renderStep()
    const applyButton = screen.getByTestId('crop-step-apply') as HTMLButtonElement
    expect(applyButton.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('mock-cropper'))
    expect(applyButton.disabled).toBe(false)
  })

  it('confirms with the rect computed from the selected percentage area', () => {
    const { onConfirm } = renderStep()
    fireEvent.click(screen.getByTestId('mock-cropper'))
    fireEvent.click(screen.getByTestId('crop-step-apply'))

    expect(onConfirm).toHaveBeenCalledWith({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })

  it('Cancel calls onClose without confirming', () => {
    const { onConfirm, onClose } = renderStep()
    fireEvent.click(screen.getByText('Cancel'))

    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders nothing crop-related when closed', () => {
    renderStep({ opened: false })
    expect(screen.queryByTestId('mock-cropper')).toBeNull()
    expect(screen.queryByTestId('crop-step-apply')).toBeNull()
  })
})
