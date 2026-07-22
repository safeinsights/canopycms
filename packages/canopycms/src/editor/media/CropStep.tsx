'use client'

import React, { useState } from 'react'

import { Button, Group, Modal, Slider, Stack, Text } from '@mantine/core'
import Cropper, { type Area } from 'react-easy-crop'

import type { CropRect } from '../../assets/transform-directives'
import { cropAreaPercentToRect, cropRectToAreaPercent } from './crop-math'

export interface CropStepProps {
  opened: boolean
  onClose: () => void
  /** Full-frame image src to crop - `assetUrl()` with no crop directive, so the user always crops the original frame. */
  imageSrc: string
  /** Numeric aspect ratio (width/height) parsed from the field config's "W:H" string. */
  aspect: number
  /** Existing crop rect, if re-cropping - seeds react-easy-crop's initial selection (best effort). */
  initialCrop?: CropRect
  onConfirm: (rect: CropRect) => void
}

const MIN_ZOOM = 1
const MAX_ZOOM = 3
const ZOOM_STEP = 0.05

/**
 * react-easy-crop wrapped in a Modal for the ImageField crop step. Percentage
 * -> normalized-rect conversion is delegated to crop-math.ts's pure,
 * independently-unit-tested `cropAreaPercentToRect`.
 *
 * The pan/zoom/pending-selection state lives in `CropStepBody`, mounted only
 * while `opened` and keyed on `imageSrc` - so a fresh crop session always
 * starts from fresh state (React remounts on key change) without an effect
 * that would otherwise need to call `setState` synchronously to reset it.
 */
export const CropStep: React.FC<CropStepProps> = ({
  opened,
  onClose,
  imageSrc,
  aspect,
  initialCrop,
  onConfirm,
}) => {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Crop image"
      size="lg"
      overlayProps={{ blur: 2 }}
      data-testid="crop-step-modal"
    >
      {opened && (
        <CropStepBody
          key={imageSrc}
          imageSrc={imageSrc}
          aspect={aspect}
          initialCrop={initialCrop}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      )}
    </Modal>
  )
}

interface CropStepBodyProps {
  imageSrc: string
  aspect: number
  initialCrop?: CropRect
  onConfirm: (rect: CropRect) => void
  onClose: () => void
}

const CropStepBody: React.FC<CropStepBodyProps> = ({
  imageSrc,
  aspect,
  initialCrop,
  onConfirm,
  onClose,
}) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [pendingArea, setPendingArea] = useState<Area | null>(null)

  const handleConfirm = () => {
    if (!pendingArea) return
    const rect = cropAreaPercentToRect(pendingArea)
    if (rect) onConfirm(rect)
  }

  const initialCroppedAreaPercentages = initialCrop ? cropRectToAreaPercent(initialCrop) : undefined

  return (
    <Stack gap="md">
      <div style={{ position: 'relative', width: '100%', height: 360, background: '#000' }}>
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          initialCroppedAreaPercentages={initialCroppedAreaPercentages}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(croppedArea) => setPendingArea(croppedArea)}
        />
      </div>
      <Group gap="sm" align="center">
        <Text size="sm" w={50}>
          Zoom
        </Text>
        <Slider
          style={{ flex: 1 }}
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={ZOOM_STEP}
          value={zoom}
          onChange={setZoom}
          label={(value) => `${value.toFixed(2)}x`}
        />
      </Group>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleConfirm} disabled={!pendingArea} data-testid="crop-step-apply">
          Apply crop
        </Button>
      </Group>
    </Stack>
  )
}

export default CropStep
