'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core'
import { Dropzone, type FileRejection } from '@mantine/dropzone'
import { openConfirm } from '../utils/confirm-modal'
import {
  IconAlertCircle,
  IconGridDots,
  IconLayoutGrid,
  IconList,
  IconSearch,
  IconUpload,
  IconX,
} from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { getErrorMessage } from '../../utils/error'
// Import directly from helpers (not the authorization barrel) to keep server-only
// authorization code out of this client bundle - matches BranchManager's convention.
import { isAdmin } from '../../authorization/helpers'
import { useApiClient, useAssetContext } from '../context'
import { useUserContext } from '../hooks'
import { AssetCard } from './AssetCard'
import { AssetListRow } from './AssetListRow'
import { MediaLibrarySkeleton } from './MediaLibrarySkeleton'
import { useAssetLibrary } from './useAssetLibrary'
import { useAssetUpload } from './useAssetUpload'
import { useMediaLibraryPrefs } from './media-library-prefs'
import {
  GRID_COLUMNS,
  assetCountLabel,
  matchesKind,
  matchesText,
  sortAssets,
  type MediaDensity,
  type MediaKind,
  type MediaSort,
} from './media-library-view'
import {
  ACCEPTED_ASSET_MIME_TYPES,
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from './upload-constants'

/** How many assets render at first, and how many each reveal adds. All of them load regardless. */
const RENDER_WINDOW = 40

const SORT_OPTIONS: { value: MediaSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name' },
]

const KIND_OPTIONS: { value: MediaKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'images', label: 'Images' },
  { value: 'pdfs', label: 'PDFs' },
]

/** An icon-only radio segment: the visible icon, a tooltip, and hidden text for the radio's name. */
const DensityLabel: React.FC<{ icon: React.ReactNode; text: string }> = ({ icon, text }) => (
  <Tooltip label={text}>
    <Center>
      {icon}
      <VisuallyHidden>{text}</VisuallyHidden>
    </Center>
  </Tooltip>
)

const DENSITY_OPTIONS: { value: MediaDensity; label: React.ReactNode }[] = [
  { value: 'grid', label: <DensityLabel icon={<IconLayoutGrid size={16} />} text="Grid" /> },
  {
    value: 'compact',
    label: <DensityLabel icon={<IconGridDots size={16} />} text="Compact grid" />,
  },
  { value: 'list', label: <DensityLabel icon={<IconList size={16} />} text="List" /> },
]

export interface MediaLibraryBodyProps {
  /** Whether the enclosing Drawer/Modal is open - the library (re)loads from page 1 on each open and stops loading on close. */
  opened: boolean
  mode: 'manage' | 'picker'
  /** Present in picker mode - clicking a card (or completing an upload) selects the asset. */
  onSelect?: (asset: AssetRecord) => void
}

/**
 * Shared grid/list/upload/search/delete core for both MediaLibrary
 * presentations (Drawer "manage" mode, Modal "picker" mode) - see
 * MediaLibrary.tsx for the two wrappers.
 */
export const MediaLibraryBody: React.FC<MediaLibraryBodyProps> = ({ opened, mode, onSelect }) => {
  const client = useApiClient()
  const { baseUrl } = useAssetContext()
  const { userContext } = useUserContext()
  // Mirrors the server's rule in api/assets.ts's deleteAssetHandler: an admin
  // may delete anything, anyone else only what they uploaded. Kept per-asset
  // (not a single boolean) because ownership varies row by row. The server is
  // still the authority - this only decides whether to render the control.
  const canDeleteAsset = (asset: AssetRecord): boolean => {
    if (mode !== 'manage') return false
    if (isAdmin(userContext?.groups)) return true
    return !!asset.uploadedBy && asset.uploadedBy === userContext?.userId
  }
  const upload = useAssetUpload()
  // `picker` mode is used exclusively by ImageField and the MDX image dialog
  // (see MediaLibraryProps.mode's doc comment) - both image-only contexts.
  // `manage` mode (the Editor's Media Library drawer) keeps accepting PDFs.
  const imageOnly = mode === 'picker'

  const library = useAssetLibrary(opened)
  const { sort, density, setSort, setDensity } = useMediaLibraryPrefs()
  const [kind, setKind] = useState<MediaKind>('all')
  const [filterText, setFilterText] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  // The render window resets whenever the list it windows changes shape; keying it on the
  // controls avoids an effect and the stale frame an effect would leave.
  const windowKey = `${filterText}|${sort}|${kind}|${density}`
  const [windowState, setWindowState] = useState({ key: windowKey, count: RENDER_WINDOW })
  const visibleCount = windowState.key === windowKey ? windowState.count : RENDER_WINDOW
  const showMore = useCallback(
    () => setWindowState({ key: windowKey, count: visibleCount + RENDER_WINDOW }),
    [windowKey, visibleCount],
  )

  const needle = filterText.trim().toLowerCase()
  const effectiveKind: MediaKind = imageOnly ? 'images' : kind
  // Picker mode is image-only (see `imageOnly` above) - pdf assets are
  // excluded from the pickable list entirely, not just the upload accept
  // list, since an already-uploaded pdf could otherwise still be selected.
  const scopedAssets = useMemo(
    () => (imageOnly ? library.assets.filter((asset) => asset.kind !== 'pdf') : library.assets),
    [imageOnly, library.assets],
  )
  const kindAssets = useMemo(
    () => scopedAssets.filter((asset) => matchesKind(asset, effectiveKind)),
    [scopedAssets, effectiveKind],
  )
  const matchedAssets = useMemo(
    () => sortAssets(kindAssets, sort).filter((asset) => matchesText(asset, needle)),
    [kindAssets, sort, needle],
  )
  const visibleAssets = matchedAssets.slice(0, visibleCount)
  const hasMore = matchedAssets.length > visibleAssets.length

  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore()
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel, hasMore, showMore])

  const handleDrop = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setActionError(null)
    const asset = await upload.upload(file)
    if (asset) library.prepend(asset)
  }

  const handleReject = (rejections: FileRejection[]) => {
    setActionError(rejections[0]?.errors[0]?.message ?? 'The file was rejected.')
  }

  const handleDelete = async (asset: AssetRecord) => {
    setActionError(null)
    try {
      const result = await client.assets.delete({ key: asset.hash32 })
      if (!result.ok) {
        setActionError(
          `Couldn't remove ${asset.filename} from the library. ${result.error || 'Try again.'}`,
        )
        return
      }
      library.remove(asset.hash32)
    } catch (err) {
      setActionError(`Couldn't remove ${asset.filename} from the library. ${getErrorMessage(err)}`)
    }
  }

  const handleDeleteClick = (asset: AssetRecord) => {
    openConfirm({
      title: 'Remove from library',
      children: (
        <Text size="sm">
          Remove &ldquo;{asset.filename}&rdquo; from the media library? Existing content that
          already references this file keeps working - removing it here only hides it from the
          library; the file itself is not deleted.
        </Text>
      ),
      labels: { confirm: 'Remove from library', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void handleDelete(asset)
      },
    })
  }

  const loadStatus = ((): React.ReactNode => {
    if (library.error || !library.firstPageLoaded) return null
    if (!library.complete) {
      return needle ? (
        <Group gap={6} wrap="nowrap">
          <Loader size={12} />
          <span>Searching {assetCountLabel(kindAssets.length)} loaded so far…</span>
        </Group>
      ) : (
        `Loaded ${assetCountLabel(scopedAssets.length)}, loading more…`
      )
    }
    if (needle) {
      const total = kindAssets.length
      return `${matchedAssets.length} of ${total} ${total === 1 ? 'asset matches' : 'assets match'}`
    }
    return null
  })()

  const emptyState = ((): React.ReactNode => {
    if (!library.complete || matchedAssets.length > 0) return null
    if (scopedAssets.length === 0) {
      return imageOnly
        ? 'No images yet. Drop an image above to upload one.'
        : 'No media yet. Drop a file above to upload one.'
    }
    if (needle) return `No assets match “${filterText.trim()}”.`
    if (effectiveKind === 'pdfs') return 'No PDFs in the library.'
    return 'No images in the library.'
  })()

  const renderList = () => {
    if (density === 'list') {
      return (
        <Stack gap={4}>
          {visibleAssets.map((asset) => (
            <AssetListRow
              key={asset.hash32}
              asset={asset}
              baseUrl={baseUrl}
              onSelect={mode === 'picker' ? onSelect : undefined}
              onDelete={canDeleteAsset(asset) ? () => handleDeleteClick(asset) : undefined}
            />
          ))}
        </Stack>
      )
    }
    return (
      <SimpleGrid cols={GRID_COLUMNS[density]} spacing="sm">
        {visibleAssets.map((asset) => (
          <AssetCard
            key={asset.hash32}
            asset={asset}
            baseUrl={baseUrl}
            density={density}
            onSelect={mode === 'picker' ? onSelect : undefined}
            onDelete={canDeleteAsset(asset) ? () => handleDeleteClick(asset) : undefined}
          />
        ))}
      </SimpleGrid>
    )
  }

  const listContent = (
    <>
      {!library.firstPageLoaded && !library.error && <MediaLibrarySkeleton density={density} />}
      {library.firstPageLoaded && visibleAssets.length > 0 && renderList()}
      {emptyState && (
        <Stack align="center" gap="xs" py="xl" data-testid="media-library-empty">
          <Text size="sm" c="dimmed" ta="center">
            {emptyState}
          </Text>
          {needle && (
            <Button variant="light" size="xs" onClick={() => setFilterText('')}>
              Clear search
            </Button>
          )}
        </Stack>
      )}
      {hasMore && (
        <>
          <div ref={setSentinel} aria-hidden="true" style={{ height: 1 }} />
          <Group justify="center" py="sm">
            <Button variant="light" onClick={showMore} data-testid="media-library-show-more">
              Show more
            </Button>
          </Group>
        </>
      )}
    </>
  )

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
        placeholder="Search by filename"
        aria-label="Search by filename"
        leftSection={<IconSearch size={16} />}
        rightSection={
          filterText ? (
            <Tooltip label="Clear search">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Clear search"
                onClick={() => setFilterText('')}
              >
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          ) : null
        }
        value={filterText}
        onChange={(event) => setFilterText(event.currentTarget.value)}
        data-testid="media-library-filter"
      />

      <Group justify="space-between" wrap="wrap" gap="xs">
        {imageOnly ? (
          <span />
        ) : (
          <SegmentedControl
            aria-label="Kind"
            data={KIND_OPTIONS}
            value={kind}
            onChange={(value) =>
              setKind(KIND_OPTIONS.find((o) => o.value === value)?.value ?? 'all')
            }
            data-testid="media-library-kind"
          />
        )}
        <Group gap="xs" wrap="wrap">
          <Select
            aria-label="Sort by"
            data={SORT_OPTIONS}
            value={sort}
            onChange={(value) => {
              const next = SORT_OPTIONS.find((option) => option.value === value)
              if (next) setSort(next.value)
            }}
            allowDeselect={false}
            w={150}
            data-testid="media-library-sort"
          />
          <SegmentedControl
            aria-label="Layout"
            data={DENSITY_OPTIONS}
            value={density}
            onChange={(value) => {
              const next = DENSITY_OPTIONS.find((option) => option.value === value)
              if (next) setDensity(next.value)
            }}
            data-testid="media-library-density"
          />
        </Group>
      </Group>

      {loadStatus && (
        <Text
          component="div"
          size="xs"
          c="dimmed"
          role="status"
          aria-live="polite"
          data-testid="media-library-load-status"
        >
          {loadStatus}
        </Text>
      )}

      {library.error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" data-testid="media-library-error">
          <Stack gap={4}>
            <Text size="sm">
              {library.error.firstPage
                ? "Couldn't load the media library."
                : `Couldn't load the rest of the media library. Showing the ${assetCountLabel(library.assets.length)} loaded so far.`}
            </Text>
            <Text size="xs" c="dimmed">
              {library.error.message}
            </Text>
            <Button variant="light" onClick={library.retry}>
              Retry
            </Button>
          </Stack>
        </Alert>
      )}
      {actionError && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          withCloseButton
          closeButtonLabel="Dismiss"
          onClose={() => setActionError(null)}
          data-testid="media-library-action-error"
        >
          {actionError}
        </Alert>
      )}

      {imageOnly ? (
        <ScrollArea.Autosize mah="60vh">{listContent}</ScrollArea.Autosize>
      ) : (
        <ScrollArea style={{ flex: 1 }}>{listContent}</ScrollArea>
      )}
    </Stack>
  )
}
