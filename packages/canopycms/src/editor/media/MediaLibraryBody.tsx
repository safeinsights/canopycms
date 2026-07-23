'use client'

import React, { useCallback, useEffect, useState } from 'react'

import {
  Alert,
  Button,
  Group,
  Loader,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { Dropzone, type FileRejection } from '@mantine/dropzone'
import { modals } from '@mantine/modals'
import { IconAlertCircle, IconUpload } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { getErrorMessage } from '../../utils/error'
// Import directly from helpers (not the authorization barrel) to keep server-only
// authorization code out of this client bundle - matches BranchManager's convention.
import { isAdmin } from '../../authorization/helpers'
import { useApiClient, useAssetContext } from '../context'
import { useUserContext } from '../hooks'
import { AssetCard } from './AssetCard'
import { useAssetUpload } from './useAssetUpload'
import {
  ACCEPTED_ASSET_MIME_TYPES,
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from './upload-constants'

const PAGE_SIZE = 40

export interface MediaLibraryBodyProps {
  /** Whether the enclosing Drawer/Modal is open - gates the (re)fetch of the first page on each open. */
  opened: boolean
  mode: 'manage' | 'picker'
  /** Present in picker mode - clicking a card (or completing an upload) selects the asset. */
  onSelect?: (asset: AssetRecord) => void
}

/**
 * Shared grid/upload/filter/pagination/delete core for both MediaLibrary
 * presentations (Drawer "manage" mode, Modal "picker" mode) - see
 * MediaLibrary.tsx for the two wrappers.
 */
export const MediaLibraryBody: React.FC<MediaLibraryBodyProps> = ({ opened, mode, onSelect }) => {
  const client = useApiClient()
  const { baseUrl } = useAssetContext()
  const { userContext } = useUserContext()
  const canDelete = mode === 'manage' && isAdmin(userContext?.groups)
  const upload = useAssetUpload()
  // `picker` mode is used exclusively by ImageField and the MDX image dialog
  // (see MediaLibraryProps.mode's doc comment) - both image-only contexts.
  // `manage` mode (the Editor's Media Library drawer) keeps accepting PDFs.
  const imageOnly = mode === 'picker'

  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')

  const loadFirstPage = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const result = await client.assets.list({ limit: String(PAGE_SIZE) })
      if (!result.ok || !result.data) {
        setListError(result.error || 'Failed to load assets')
        return
      }
      setAssets(result.data.assets)
      setNextCursor(result.data.nextCursor)
    } catch (err) {
      setListError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    if (!opened) return
    void loadFirstPage()
    // Refetch only when the drawer/modal (re)opens, not on every render where
    // loadFirstPage's identity happens to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  const handleLoadMore = async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    setListError(null)
    try {
      const result = await client.assets.list({ cursor: nextCursor, limit: String(PAGE_SIZE) })
      if (!result.ok || !result.data) {
        setListError(result.error || 'Failed to load more assets')
        return
      }
      const page = result.data
      setAssets((prev) => [...prev, ...page.assets])
      setNextCursor(page.nextCursor)
    } catch (err) {
      setListError(getErrorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const handleDrop = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    const asset = await upload.upload(file)
    if (asset) {
      setAssets((prev) => [asset, ...prev])
    }
  }

  const handleReject = (rejections: FileRejection[]) => {
    setListError(rejections[0]?.errors[0]?.message ?? 'File rejected')
  }

  const handleDelete = async (asset: AssetRecord) => {
    const result = await client.assets.delete({ key: asset.hash32 })
    if (!result.ok) {
      setListError(result.error || 'Failed to delete asset')
      return
    }
    setAssets((prev) => prev.filter((a) => a.hash32 !== asset.hash32))
  }

  const handleDeleteClick = (asset: AssetRecord) => {
    modals.openConfirmModal({
      title: 'Remove from library',
      children: (
        <Text size="sm">
          Remove &ldquo;{asset.filename}&rdquo; from the media library? Existing content that
          already references this file keeps working - removing it here only hides it from the
          library; the file itself is not deleted.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void handleDelete(asset)
      },
    })
  }

  // Picker mode is image-only (see `imageOnly` above) - pdf assets are
  // filtered out of the pickable grid entirely, not just the upload accept
  // list, since an already-uploaded pdf could otherwise still be selected.
  const kindFiltered = imageOnly ? assets.filter((asset) => asset.kind !== 'pdf') : assets
  const normalizedFilter = filterText.trim().toLowerCase()
  const filteredAssets = normalizedFilter
    ? kindFiltered.filter((asset) => asset.filename.toLowerCase().includes(normalizedFilter))
    : kindFiltered

  return (
    <Stack gap="sm" h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
      <Dropzone
        onDrop={(files) => void handleDrop(files)}
        onReject={handleReject}
        maxSize={MAX_UPLOAD_BYTES}
        accept={imageOnly ? ACCEPTED_IMAGE_MIME_TYPES : ACCEPTED_ASSET_MIME_TYPES}
        loading={upload.uploading}
        multiple={false}
        data-testid="media-library-dropzone"
      >
        <Group justify="center" gap="xs" py="sm" style={{ pointerEvents: 'none' }}>
          <IconUpload size={20} />
          <Text size="sm">
            {imageOnly
              ? 'Drop an image here, or click to browse'
              : 'Drop an image or PDF here, or click to browse'}
          </Text>
        </Group>
      </Dropzone>

      {upload.uploading &&
        (upload.progress !== null ? (
          <Progress value={upload.progress * 100} size="sm" data-testid="upload-progress" />
        ) : (
          <Progress value={100} size="sm" animated data-testid="upload-progress-indeterminate" />
        ))}
      {upload.error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" data-testid="upload-error">
          {upload.error}
        </Alert>
      )}

      <TextInput
        placeholder="Filter by filename..."
        value={filterText}
        onChange={(event) => setFilterText(event.currentTarget.value)}
        data-testid="media-library-filter"
      />

      {listError && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" data-testid="media-library-error">
          <Stack gap={4}>
            <Text size="sm">{listError}</Text>
            <Button size="xs" variant="light" onClick={() => void loadFirstPage()}>
              Retry
            </Button>
          </Stack>
        </Alert>
      )}

      <ScrollArea style={{ flex: 1 }}>
        {loading ? (
          <Group justify="center" py="xl">
            <Loader size="sm" data-testid="media-library-loading" />
          </Group>
        ) : filteredAssets.length === 0 ? (
          <Text size="sm" c="dimmed" py="xl" ta="center">
            No assets found.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="sm">
            {filteredAssets.map((asset) => (
              <AssetCard
                key={asset.hash32}
                asset={asset}
                baseUrl={baseUrl}
                onSelect={mode === 'picker' ? onSelect : undefined}
                onDelete={canDelete ? () => handleDeleteClick(asset) : undefined}
              />
            ))}
          </SimpleGrid>
        )}

        {!loading && nextCursor && (
          <Group justify="center" py="sm">
            <Button
              variant="light"
              size="xs"
              loading={loadingMore}
              onClick={() => void handleLoadMore()}
              data-testid="media-library-load-more"
            >
              Load more
            </Button>
          </Group>
        )}
      </ScrollArea>
    </Stack>
  )
}

export default MediaLibraryBody
