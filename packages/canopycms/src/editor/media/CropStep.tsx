'use client'

import React, { useState } from 'react'

import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import ReactCrop, { type PercentCrop } from 'react-image-crop'

import type { CropRect } from '../../assets/transform-directives'
import { cropAreaPercentToRect, initialCropBox } from './crop-math'

export interface CropStepProps {
  opened: boolean
  onClose: () => void
  /** Full-frame image src to crop - `assetUrl()` with no crop directive, so the user always crops the original frame. */
  imageSrc: string
  /** Numeric aspect ratio (width/height) parsed from the field config's "W:H" string. Absent: the crop box is free-form. */
  aspect?: number
  /** Existing crop rect, if re-cropping - the box it opens with. */
  initialCrop?: CropRect
  onConfirm: (rect: CropRect) => void
}

const MIN_BOX_PX = 16
const PREVIEW_MAX_HEIGHT = 360

const toPercentCrop = (box: {
  x: number
  y: number
  width: number
  height: number
}): PercentCrop => ({
  unit: '%',
  ...box,
})

/**
 * react-image-crop in a Modal for the ImageField crop step. Box -> normalized-rect
 * conversion is delegated to crop-math.ts's pure, independently-unit-tested
 * `cropAreaPercentToRect`.
 *
 * The box state lives in `CropStepBody`, mounted only while `opened` and keyed on `imageSrc`,
 * so a fresh crop session always starts from a fresh box (React remounts on key change).
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
  aspect?: number
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
  const [box, setBox] = useState<PercentCrop | undefined>(undefined)

  // The box can't be seeded until the image's displayed size is known, so Apply stays off until then.
  const rect = box ? cropAreaPercentToRect(box) : null

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = event.currentTarget
    setBox(
      toPercentCrop(
        initialCropBox({ imageWidth: width, imageHeight: height, aspect, existing: initialCrop }),
      ),
    )
  }

  return (
    <Stack gap="md">
      <div
        style={
          {
            display: 'flex',
            justifyContent: 'center',
            background: 'var(--mantine-color-black)',
            '--rc-focus-color': 'var(--canopy-focus-ring)',
          } as React.CSSProperties
        }
      >
        <ReactCrop
          crop={box}
          aspect={aspect}
          minWidth={MIN_BOX_PX}
          minHeight={MIN_BOX_PX}
          keepSelection
          onChange={(_pixels, percent) => setBox(percent)}
        >
          <img
            src={imageSrc}
            alt=""
            style={{ maxHeight: PREVIEW_MAX_HEIGHT, maxWidth: '100%', display: 'block' }}
            onLoad={handleImageLoad}
          />
        </ReactCrop>
      </div>
      <Text size="sm" c="dimmed">
        {aspect === undefined
          ? 'Drag the box to move it, or its edges and corners to resize it. Arrow keys nudge it.'
          : 'Drag the box to move it, or a corner to resize it. Its shape is fixed. Arrow keys nudge it.'}
      </Text>
      <Group justify="flex-end">
        <Button size="sm" variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => rect && onConfirm(rect)}
          disabled={!rect}
          data-testid="crop-step-apply"
        >
          Apply crop
        </Button>
      </Group>
    </Stack>
  )
}
