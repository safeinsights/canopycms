'use client'

import React, { useEffect, useId, useRef, useState } from 'react'

import {
  Alert,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core'
import { Dropzone, type FileRejection } from '@mantine/dropzone'
import { IconAlertCircle, IconPhoto, IconPhotoOff, IconUpload } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { EDITOR_THUMBNAIL_WIDTHS } from '../../assets/editor-thumbnail-widths'
import type { CropRect } from '../../assets/transform-directives'
import type { ImageFieldValue } from '../../config'
import { useAssetContext } from '../context'
import { CropStep } from '../media/CropStep'
import { cropBlockedReason } from '../media/crop-availability'
import { editorImageSrc } from '../media/editor-image-src'
import { parseAspectRatio } from '../media/crop-math'
import { MediaLibrary } from '../media/MediaLibrary'
import { useAssetUpload } from '../media/useAssetUpload'
import { ACCEPTED_IMAGE_MIME_TYPES, MAX_UPLOAD_BYTES } from '../media/upload-constants'
import { useFieldCommentControl } from '../comments/field-comment-context'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'

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
  /** "W:H" aspect ratio - when set, picking/uploading a new image opens the crop step before the value commits, and Crop keeps that shape. Without it, a pick commits as is and Crop is free-form. */
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

const PREVIEW_WIDTH = EDITOR_THUMBNAIL_WIDTHS.imageField

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
  const commentControl = useFieldCommentControl(dataCanopyField)
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
  const cropBlocked = value ? cropBlockedReason(value.src) : undefined
  const cropReasonId = `${inputId}-crop-reason`
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
    if (aspectRatio !== undefined && !cropBlockedReason(asset.src)) {
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

  const handleRemove = (event: React.MouseEvent<HTMLElement>) => {
    if (readOnly || !value) return
    const field = event.currentTarget.closest<HTMLElement>('[data-removal-focus]')
    edit(undefined)
    onRemoved?.(value)
    field?.focus()
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

  const actions =
    hasValue && !readOnly ? (
      <>
        <Button
          size="compact-sm"
          variant="light"
          onClick={() => setPickerOpen(true)}
          data-testid={`image-field-replace-${dataCanopyField}`}
        >
          Replace
        </Button>
        <Tooltip
          label={cropBlocked}
          disabled={!cropBlocked}
          position="bottom-end"
          multiline
          maw={280}
        >
          <Button
            size="compact-sm"
            variant="light"
            onClick={() => {
              if (!cropBlocked) setCropRequest({ kind: 'existing' })
            }}
            data-disabled={cropBlocked ? true : undefined}
            aria-disabled={cropBlocked ? true : undefined}
            // The Tooltip names no description, so a screen reader reaches the reason here.
            aria-describedby={cropBlocked ? cropReasonId : undefined}
            data-testid={`image-field-crop-${dataCanopyField}`}
          >
            Crop
          </Button>
        </Tooltip>
        {cropBlocked && <VisuallyHidden id={cropReasonId}>{cropBlocked}</VisuallyHidden>}
        <Button
          size="compact-sm"
          variant="subtle"
          color="red"
          onClick={handleRemove}
          data-testid={`image-field-remove-${dataCanopyField}`}
        >
          Remove
        </Button>
      </>
    ) : undefined

  return (
    <Paper
      withBorder
      p="md"
      bg="var(--canopy-surface-subtle)"
      shadow="xs"
      data-canopy-field={dataCanopyField}
      data-testid={`image-field-${dataCanopyField}`}
      {...groupDescriptionProps(inputId, description)}
      role="group"
      aria-label={label}
      data-removal-focus
      tabIndex={-1}
    >
      <Stack gap="sm">
        <FieldLabel
          label={label}
          description={description}
          descriptionBaseId={inputId}
          commentControl={commentControl}
          actions={actions}
        />

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
              <Text size="xs" c="var(--canopy-danger-text)">
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
                  background: 'var(--canopy-surface-muted)',
                }}
              >
                <IconPhotoOff size={28} stroke={1.5} color="var(--mantine-color-dimmed)" />
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
              <Text size="xs" c="var(--canopy-danger-text)">
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
            {errors?.crop && (
              <Text size="xs" c="var(--canopy-danger-text)">
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

        {!readOnly && (
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
    </Paper>
  )
}
