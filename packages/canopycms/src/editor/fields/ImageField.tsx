'use client'

import React, { useEffect, useId, useRef, useState } from 'react'

import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core'
import { Dropzone, type FileRejection } from '@mantine/dropzone'
import { IconAlertCircle, IconPhoto, IconUpload } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { assetUrl } from '../../assets/asset-url'
import type { CropRect } from '../../assets/transform-directives'
import type { ImageFieldValue } from '../../config'
import { useAssetContext } from '../context'
import { CropStep } from '../media/CropStep'
import { parseAspectRatio } from '../media/crop-math'
import { MediaLibrary } from '../media/MediaLibrary'
import { useAssetUpload } from '../media/useAssetUpload'
import { ACCEPTED_IMAGE_MIME_TYPES, MAX_UPLOAD_BYTES } from '../media/upload-constants'

export interface ImageFieldErrors {
  src?: string
  alt?: string
  crop?: string
}

export interface ImageFieldProps {
  id?: string
  label?: string
  value: ImageFieldValue | undefined
  onChange: (value: ImageFieldValue | undefined) => void
  /** "W:H" aspect ratio - when set, picking/uploading a new image opens the crop step before the value commits, and a "Crop" button appears on the filled state. */
  aspect?: string
  /** Allow empty alt text. Default: required (accessibility). */
  altOptional?: boolean
  dataCanopyField?: string
  errors?: ImageFieldErrors
}

/** Which image the crop step is currently cropping. */
type CropRequest = { kind: 'new'; asset: AssetRecord } | { kind: 'existing' }

const PREVIEW_WIDTH = 320

export const ImageField: React.FC<ImageFieldProps> = ({
  id,
  label,
  value,
  onChange,
  aspect,
  altOptional,
  dataCanopyField,
  errors,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const { baseUrl } = useAssetContext()
  const upload = useAssetUpload()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cropRequest, setCropRequest] = useState<CropRequest | null>(null)
  // Dropzone-level rejections (wrong type/too large) never reach useAssetUpload
  // (Dropzone filters them out before onDrop fires), so they need their own
  // error slot rather than piggybacking on upload.error.
  const [dropError, setDropError] = useState<string | null>(null)
  const altInputRef = useRef<HTMLInputElement>(null)
  const justCommittedRef = useRef(false)

  const aspectRatio = parseAspectRatio(aspect)
  const hasValue = !!value?.src

  // Focus the alt input right after a new image commits (pick or upload),
  // so the editor's next keystroke goes straight into the field most likely
  // to need attention.
  useEffect(() => {
    if (justCommittedRef.current) {
      justCommittedRef.current = false
      altInputRef.current?.focus()
    }
  }, [value?.src])

  const commitAsset = (asset: AssetRecord, crop?: CropRect) => {
    justCommittedRef.current = true
    onChange({
      src: asset.src,
      // Preserve the current alt text on replace - it often still describes
      // the new image (e.g. "hero photo"), and the editor can always edit it.
      // Selecting into an empty field has no prior alt, so it stays ''.
      alt: value?.alt ?? '',
      ...(asset.width !== undefined ? { width: asset.width } : {}),
      ...(asset.height !== undefined ? { height: asset.height } : {}),
      ...(crop ? { crop } : {}),
    })
  }

  const handleAssetReady = (asset: AssetRecord) => {
    setPickerOpen(false)
    if (aspectRatio !== undefined) {
      setCropRequest({ kind: 'new', asset })
    } else {
      commitAsset(asset)
    }
  }

  const handleDrop = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    const asset = await upload.upload(file)
    if (asset) handleAssetReady(asset)
  }

  const handleReject = (rejections: FileRejection[]) => {
    setDropError(rejections[0]?.errors[0]?.message ?? 'File rejected')
  }

  const handleAltChange = (nextAlt: string) => {
    if (!value) return
    onChange({ ...value, alt: nextAlt })
  }

  const handleRemove = () => {
    onChange(undefined)
  }

  const handleCropConfirm = (rect: CropRect) => {
    if (cropRequest?.kind === 'new') {
      commitAsset(cropRequest.asset, rect)
    } else if (cropRequest?.kind === 'existing' && value) {
      onChange({ ...value, crop: rect })
    }
    setCropRequest(null)
  }

  const cropImageSrc =
    cropRequest?.kind === 'new'
      ? assetUrl({ src: cropRequest.asset.src }, { baseUrl })
      : cropRequest?.kind === 'existing' && value
        ? assetUrl({ src: value.src }, { baseUrl })
        : ''
  const cropInitial = cropRequest?.kind === 'existing' ? value?.crop : undefined

  return (
    <Stack
      gap={4}
      data-canopy-field={dataCanopyField}
      data-testid={`image-field-${dataCanopyField}`}
    >
      {label && (
        <Text size="sm" fw={500}>
          {label}
        </Text>
      )}

      {!hasValue ? (
        <Stack gap="xs">
          <Dropzone
            onDrop={(files) => void handleDrop(files)}
            onReject={handleReject}
            maxSize={MAX_UPLOAD_BYTES}
            accept={ACCEPTED_IMAGE_MIME_TYPES}
            loading={upload.uploading}
            multiple={false}
            data-testid={`image-field-dropzone-${dataCanopyField}`}
          >
            <Group justify="center" gap="xs" py="xs" style={{ pointerEvents: 'none' }}>
              <IconUpload size={18} />
              <Text size="xs">Drop an image here, or click to browse</Text>
            </Group>
          </Dropzone>
          <Group justify="center">
            <Button
              variant="light"
              size="xs"
              leftSection={<IconPhoto size={14} />}
              onClick={() => setPickerOpen(true)}
              data-testid={`image-field-browse-library-${dataCanopyField}`}
            >
              Browse library
            </Button>
          </Group>
          {(upload.error || dropError) && (
            <Alert icon={<IconAlertCircle size={16} />} color="red">
              {upload.error || dropError}
            </Alert>
          )}
          {errors?.src && (
            <Text size="xs" c="red">
              {errors.src}
            </Text>
          )}
        </Stack>
      ) : (
        <Stack gap="xs">
          <img
            src={assetUrl(
              { src: value!.src },
              { width: PREVIEW_WIDTH, crop: value!.crop, baseUrl },
            )}
            alt={value!.alt}
            style={{
              maxWidth: PREVIEW_WIDTH,
              maxHeight: PREVIEW_WIDTH,
              borderRadius: 'var(--mantine-radius-sm)',
              display: 'block',
            }}
          />
          {errors?.src && (
            <Text size="xs" c="red">
              {errors.src}
            </Text>
          )}
          <TextInput
            id={inputId}
            ref={altInputRef}
            label="Alt text"
            required={!altOptional}
            value={value!.alt}
            onChange={(event) => handleAltChange(event.currentTarget.value)}
            error={errors?.alt}
            size="sm"
            data-testid={`image-field-alt-${dataCanopyField}`}
          />
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              onClick={() => setPickerOpen(true)}
              data-testid={`image-field-replace-${dataCanopyField}`}
            >
              Replace
            </Button>
            {aspectRatio !== undefined && (
              <Button
                variant="light"
                size="xs"
                onClick={() => setCropRequest({ kind: 'existing' })}
                data-testid={`image-field-crop-${dataCanopyField}`}
              >
                Crop
              </Button>
            )}
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={handleRemove}
              data-testid={`image-field-remove-${dataCanopyField}`}
            >
              Remove
            </Button>
          </Group>
          {errors?.crop && (
            <Text size="xs" c="red">
              {errors.crop}
            </Text>
          )}
        </Stack>
      )}

      <MediaLibrary
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mode="picker"
        onSelect={handleAssetReady}
      />

      {aspectRatio !== undefined && (
        <CropStep
          opened={cropRequest !== null}
          onClose={() => setCropRequest(null)}
          imageSrc={cropImageSrc}
          aspect={aspectRatio}
          initialCrop={cropInitial}
          onConfirm={handleCropConfirm}
        />
      )}
    </Stack>
  )
}

export default ImageField
