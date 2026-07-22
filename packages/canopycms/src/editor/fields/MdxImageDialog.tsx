'use client'

import React, { useEffect, useState } from 'react'

import { Alert, Button, Group, Modal, Progress, Stack, Tabs, Text, TextInput } from '@mantine/core'
import { Dropzone, type FileRejection } from '@mantine/dropzone'
import { IconAlertCircle, IconUpload } from '@tabler/icons-react'

// Type-only: erased at compile time, so this file carries no runtime
// dependency on `@mdxeditor/editor` and can be unit-tested (and statically
// imported by MarkdownField.tsx) without pulling in the mdxeditor bundle -
// the realm-cell wiring (`useCellValues`/`usePublisher`/`saveImage$`/
// `closeImageDialog$`) lives in a small bridge component defined inline
// inside MarkdownField's lazy dynamic-import factory, which passes this
// component's props down as plain values.
import type {
  EditingImageDialogState,
  InactiveImageDialogState,
  NewImageDialogState,
  SaveImageParameters,
} from '@mdxeditor/editor'

import type { AssetRecord } from '../../api'
import { MediaLibraryBody } from '../media/MediaLibraryBody'
import { useAssetUpload } from '../media/useAssetUpload'
import { ACCEPTED_ASSET_MIME_TYPES, MAX_UPLOAD_BYTES } from '../media/upload-constants'

export type MdxImageDialogState =
  | InactiveImageDialogState
  | NewImageDialogState
  | EditingImageDialogState

export interface MdxImageDialogProps {
  state: MdxImageDialogState
  onSave: (params: SaveImageParameters) => void
  onClose: () => void
}

type MdxImageDialogTab = 'upload' | 'library' | 'url'

const LIBRARY_PANEL_HEIGHT = 360

/**
 * Custom MDXEditor image dialog (Upload / From library / By URL), replacing
 * the stock upload-or-URL dialog. Wired in via `imagePlugin({ ImageDialog })`
 * in MarkdownField.tsx.
 */
export const MdxImageDialog: React.FC<MdxImageDialogProps> = ({ state, onSave, onClose }) => {
  const [tab, setTab] = useState<MdxImageDialogTab>('upload')
  const [altText, setAltText] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [dropError, setDropError] = useState<string | null>(null)
  const upload = useAssetUpload()

  const opened = state.type !== 'inactive'

  useEffect(() => {
    if (state.type === 'editing') {
      setAltText(state.initialValues.altText ?? '')
      setUrlValue(state.initialValues.src ?? '')
      // Editing an existing image: show its current src/alt on the URL tab
      // rather than defaulting to Upload, which would suggest replacing it.
      setTab('url')
    } else {
      setAltText('')
      setUrlValue('')
      setTab('upload')
    }
    setDropError(null)
    upload.reset()
    // Reset local state whenever the dialog's target state changes identity
    // (opened for a new insert, opened to edit a different node, or closed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const handleSave = (src: string) => {
    onSave({ src, altText })
    onClose()
  }

  const handleDrop = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    const asset = await upload.upload(file)
    if (asset) handleSave(asset.src)
  }

  const handleReject = (rejections: FileRejection[]) => {
    setDropError(rejections[0]?.errors[0]?.message ?? 'File rejected')
  }

  const handlePickFromLibrary = (asset: AssetRecord) => {
    handleSave(asset.src)
  }

  const handleUrlSubmit = () => {
    const trimmed = urlValue.trim()
    if (!trimmed) return
    handleSave(trimmed)
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Insert image"
      size="lg"
      overlayProps={{ blur: 2 }}
      data-testid="mdx-image-dialog"
    >
      <Stack gap="sm">
        <TextInput
          label="Alt text"
          value={altText}
          onChange={(event) => setAltText(event.currentTarget.value)}
          data-testid="mdx-image-dialog-alt"
        />

        <Tabs
          value={tab}
          onChange={(next) => {
            if (next) setTab(next as MdxImageDialogTab)
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="upload" data-testid="mdx-image-dialog-tab-upload">
              Upload
            </Tabs.Tab>
            <Tabs.Tab value="library" data-testid="mdx-image-dialog-tab-library">
              From library
            </Tabs.Tab>
            <Tabs.Tab value="url" data-testid="mdx-image-dialog-tab-url">
              By URL
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="upload" pt="sm">
            <Stack gap="xs">
              <Dropzone
                onDrop={(files) => void handleDrop(files)}
                onReject={handleReject}
                maxSize={MAX_UPLOAD_BYTES}
                accept={ACCEPTED_ASSET_MIME_TYPES}
                loading={upload.uploading}
                multiple={false}
                data-testid="mdx-image-dialog-dropzone"
              >
                <Group justify="center" gap="xs" py="sm" style={{ pointerEvents: 'none' }}>
                  <IconUpload size={20} />
                  <Text size="sm">Drop an image or PDF here, or click to browse</Text>
                </Group>
              </Dropzone>
              {upload.uploading &&
                (upload.progress !== null ? (
                  <Progress value={upload.progress * 100} size="sm" />
                ) : (
                  <Progress value={100} size="sm" animated />
                ))}
              {(upload.error || dropError) && (
                <Alert icon={<IconAlertCircle size={16} />} color="red">
                  {upload.error || dropError}
                </Alert>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="library" pt="sm">
            <div style={{ height: LIBRARY_PANEL_HEIGHT }}>
              <MediaLibraryBody
                opened={tab === 'library'}
                mode="picker"
                onSelect={handlePickFromLibrary}
              />
            </div>
          </Tabs.Panel>

          <Tabs.Panel value="url" pt="sm">
            <Stack gap="xs">
              <TextInput
                label="Image URL"
                placeholder="https://example.com/image.png"
                value={urlValue}
                onChange={(event) => setUrlValue(event.currentTarget.value)}
                data-testid="mdx-image-dialog-url"
              />
              <Group justify="flex-end">
                <Button
                  onClick={handleUrlSubmit}
                  disabled={!urlValue.trim()}
                  data-testid="mdx-image-dialog-url-submit"
                >
                  Insert
                </Button>
              </Group>
            </Stack>
          </Tabs.Panel>
        </Tabs>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

export default MdxImageDialog
