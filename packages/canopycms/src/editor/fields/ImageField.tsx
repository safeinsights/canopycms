'use client'

import React, { useEffect, useId, useRef, useState } from 'react'

import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core'
import { Dropzone, type FileRejection } from '@mantine/dropzone'
import { IconAlertCircle, IconPhoto, IconPhotoOff, IconUpload } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { isAssetStoreSrc } from '../../assets/asset-url'
import type { CropRect } from '../../assets/transform-directives'
import type { ImageFieldValue } from '../../config'
import { useAssetContext } from '../context'
import { CropStep } from '../media/CropStep'
import { editorImageSrc } from '../media/editor-image-src'
import { parseAspectRatio } from '../media/crop-math'
import { MediaLibrary } from '../media/MediaLibrary'
import { useAssetUpload } from '../media/useAssetUpload'
import { ACCEPTED_IMAGE_MIME_TYPES, MAX_UPLOAD_BYTES } from '../media/upload-constants'
import { FieldDescription, groupDescriptionProps } from './FieldDescription'

interface ImageFieldErrors {
  src?: string
  alt?: string
  crop?: string
}

export interface ImageFieldProps {
  id?: string
  label?: string
  description?: string
  value: ImageFieldValue | undefined
  onChange: (value: ImageFieldValue | undefined) => void
  /** "W:H" aspect ratio - when set, picking/uploading a new image opens the crop step before the value commits, and a "Crop" button appears on the filled state. */
  aspect?: string
  /** Allow empty alt text. Default: required (accessibility). */
  altOptional?: boolean
  dataCanopyField?: string
  errors?: ImageFieldErrors
  /** No upload, pick, crop or remove; the alt text is read-only. */
  readOnly?: boolean
  /** Told of the image Remove takes out, so the caller can offer Undo. */
  onRemoved?: (removed: ImageFieldValue) => void
}

/** Which image the crop step is currently cropping. */
type CropRequest = { kind: 'new'; asset: AssetRecord } | { kind: 'existing' }

const PREVIEW_WIDTH = 320

export const ImageField: React.FC<ImageFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  aspect,
  altOptional,
  dataCanopyField,
  errors,
  readOnly = false,
  onRemoved,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const { baseUrl } = useAssetContext()
  const upload = useAssetUpload()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cropRequest, setCropRequest] = useState<CropRequest | null>(null)
  // Dropzone-level rejections (wrong type/too large) never reach useAssetUpload
  // (filtered before onDrop fires), so they need their own error slot.
  const [dropError, setDropError] = useState<string | null>(null)
  const altInputRef = useRef<HTMLInputElement>(null)
  const justCommittedRef = useRef(false)

  const aspectRatio = parseAspectRatio(aspect)
  const hasValue = !!value?.src

  const previewSrc = value
    ? editorImageSrc(value.src, baseUrl, { width: PREVIEW_WIDTH, crop: value.crop })
    : undefined
  // `assetUrl` never applies a crop to a src outside the asset store, so one stored there never renders.
  const canCrop = aspectRatio !== undefined && !!value && isAssetStoreSrc(value.src)
  // Broken-preview fallback, mirroring AssetCard.tsx's thumbnail fallback (same
  // icon/copy, same reset-during-render pattern). Covers both an asset broken
  // at upload time and a transform failing at render time.
  const [previewFailed, setPreviewFailed] = useState(false)
  const [prevPreviewSrc, setPrevPreviewSrc] = useState(previewSrc)
  if (previewSrc !== prevPreviewSrc) {
    setPrevPreviewSrc(previewSrc)
    setPreviewFailed(false)
  }

  // Focuses the alt input right after a new image commits (pick or upload),
  // so the next keystroke lands in the field most likely to need attention.
  useEffect(() => {
    if (justCommittedRef.current) {
      justCommittedRef.current = false
      altInputRef.current?.focus()
    }
  }, [value?.src])

  const edit = (next: ImageFieldValue | undefined) => {
    if (!readOnly) onChange(next)
  }

  const commitAsset = (asset: AssetRecord, crop?: CropRect) => {
    justCommittedRef.current = true
    edit({
      src: asset.src,
      // Preserves the current alt text on replace (it often still fits); an
      // empty field has no prior alt, so it stays ''.
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
    edit({ ...value, alt: nextAlt })
  }

  const handleRemove = () => {
    if (readOnly || !value) return
    edit(undefined)
    onRemoved?.(value)
  }

  const handleCropConfirm = (rect: CropRect) => {
    if (cropRequest?.kind === 'new') {
      commitAsset(cropRequest.asset, rect)
    } else if (cropRequest?.kind === 'existing' && value) {
      edit({ ...value, crop: rect })
    }
    setCropRequest(null)
  }

  const cropImageSrc =
    cropRequest?.kind === 'new'
      ? editorImageSrc(cropRequest.asset.src, baseUrl)
      : cropRequest?.kind === 'existing' && value
        ? editorImageSrc(value.src, baseUrl)
        : ''
  const cropInitial = cropRequest?.kind === 'existing' ? value?.crop : undefined

  return (
    <Stack
      gap={4}
      data-canopy-field={dataCanopyField}
      data-testid={`image-field-${dataCanopyField}`}
      {...groupDescriptionProps(inputId, description)}
    >
      {label && (
        <Text size="sm" fw={500}>
          {label}
        </Text>
      )}
      <FieldDescription baseId={inputId} description={description} />

      {!hasValue && readOnly ? (
        <Text size="sm" c="dimmed" data-testid={`image-field-empty-${dataCanopyField}`}>
          No image
        </Text>
      ) : !hasValue ? (
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
          {previewFailed ? (
            <div
              data-testid={`image-field-preview-fallback-${dataCanopyField}`}
              style={{
                width: PREVIEW_WIDTH,
                height: 160,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                borderRadius: 'var(--mantine-radius-sm)',
                background: 'var(--mantine-color-gray-1)',
              }}
            >
              <IconPhotoOff size={28} stroke={1.5} color="var(--mantine-color-gray-5)" />
              <Text size="xs" c="dimmed">
                Preview unavailable
              </Text>
            </div>
          ) : (
            <img
              src={previewSrc}
              alt={value!.alt}
              style={{
                maxWidth: PREVIEW_WIDTH,
                maxHeight: PREVIEW_WIDTH,
                borderRadius: 'var(--mantine-radius-sm)',
                display: 'block',
              }}
              onError={() => setPreviewFailed(true)}
            />
          )}
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
            readOnly={readOnly}
            value={value!.alt}
            onChange={(event) => handleAltChange(event.currentTarget.value)}
            error={errors?.alt}
            size="sm"
            data-testid={`image-field-alt-${dataCanopyField}`}
          />
          {!readOnly && (
            <Group gap="xs">
              <Button
                variant="light"
                onClick={() => setPickerOpen(true)}
                data-testid={`image-field-replace-${dataCanopyField}`}
              >
                Replace
              </Button>
              {canCrop && (
                <Button
                  variant="light"
                  onClick={() => setCropRequest({ kind: 'existing' })}
                  data-testid={`image-field-crop-${dataCanopyField}`}
                >
                  Crop
                </Button>
              )}
              <Button
                variant="subtle"
                color="red"
                onClick={handleRemove}
                data-testid={`image-field-remove-${dataCanopyField}`}
              >
                Remove
              </Button>
            </Group>
          )}
          {errors?.crop && (
            <Text size="xs" c="red">
              {errors.crop}
            </Text>
          )}
        </Stack>
      )}

      {!readOnly && (
        <MediaLibrary
          opened={pickerOpen}
          onClose={() => setPickerOpen(false)}
          mode="picker"
          onSelect={handleAssetReady}
        />
      )}

      {aspectRatio !== undefined && !readOnly && (
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
