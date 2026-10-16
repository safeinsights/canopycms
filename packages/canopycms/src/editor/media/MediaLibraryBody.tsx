'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Group,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
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
import { isNonApiResponse } from '../../api/client'
// Import directly from helpers (not the authorization barrel) to keep server-only
// authorization code out of this client bundle - matches BranchManager's convention.
import { isAdmin } from '../../authorization/helpers'
import { useApiClient, useAssetContext } from '../context'
import { useUserContext } from '../hooks'
import { AssetCard } from './AssetCard'
import { AssetListRow } from './AssetListRow'
import { MediaLibrarySkeleton } from './MediaLibrarySkeleton'
import { useAssetLibrary } from './useAssetLibrary'
import { useStableAssetOrder } from './useStableAssetOrder'
import { useAssetUpload } from './useAssetUpload'
import { useMediaLibraryPrefs } from './media-library-prefs'
import {
  GRID_COLUMNS,
  fileCountLabel,
  matchesKind,
  matchesText,
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
  { value: 'name', label: 'Name (A–Z)' },
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
  /** Present in picker mode - clicking a card or row selects the asset; an upload is pinned first, not selected. */
  onSelect?: (asset: AssetRecord) => void
}

/** A restored file's record: the same asset, no longer marked `hidden`. */
function withoutHidden(asset: AssetRecord): AssetRecord {
  const restored = { ...asset }
  delete restored.hidden
  return restored
}

/**
 * Shared grid/list/upload/search/remove core for both MediaLibrary
 * presentations (Drawer "manage" mode, Modal "picker" mode) - see
 * MediaLibrary.tsx for the two wrappers.
 */
export const MediaLibraryBody: React.FC<MediaLibraryBodyProps> = ({ opened, mode, onSelect }) => {
  const client = useApiClient()
  const { baseUrl } = useAssetContext()
  const { userContext } = useUserContext()
  const admin = isAdmin(userContext?.groups)
  // Mirrors the server's rule in api/assets.ts's visibilityRefusal: an admin may
  // remove or restore any file, anyone else only what they uploaded. Kept per-asset
  // (not a single boolean) because ownership varies row by row. The server is
  // still the authority - this only decides whether to render the control.
  const canChangeVisibility = (asset: AssetRecord): boolean => {
    if (mode !== 'manage') return false
    if (admin) return true
    return !!asset.uploadedBy && asset.uploadedBy === userContext?.userId
  }
  // Only an admin in the manage drawer can list removed files, so a picker never offers one.
  const [showRemovedChoice, setShowRemoved] = useState(false)
  const showRemoved = showRemovedChoice && admin && mode === 'manage'
  const upload = useAssetUpload()
  // `picker` mode is used exclusively by ImageField and the MDX image dialog
  // (see MediaLibraryProps.mode's doc comment) - both image-only contexts.
  // `manage` mode (the Editor's Media Library drawer) keeps accepting PDFs.
  const imageOnly = mode === 'picker'

  const library = useAssetLibrary(opened, showRemoved)
  const { sort, density, setSort, setDensity } = useMediaLibraryPrefs()
  const [kind, setKind] = useState<MediaKind>('all')
  const [filterText, setFilterText] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  // The result of the last remove or restore, for the live region; the card may be gone.
  // `id` re-keys the region's text, so a second action with the same words is announced too.
  const [actionNotice, setActionNotice] = useState<{ id: number; text: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // A remove or restore takes the focused button with it (the card goes, or its button swaps), so
  // focus moves to the search field once that has rendered (Mantine returns focus to the remove
  // button when the confirm closes).
  const focusAfterAction = useRef(false)
  useEffect(() => {
    if (!focusAfterAction.current) return
    focusAfterAction.current = false
    searchRef.current?.focus()
  })
  const announce = (text: string) => {
    setActionNotice((prev) => ({ id: (prev?.id ?? 0) + 1, text }))
    focusAfterAction.current = true
  }
  // Clearing hides the control that did it, so focus moves to the search field.
  const clearSearch = () => {
    setFilterText('')
    searchRef.current?.focus()
  }

  // This opening's uploads, newest first; they lead the list whatever the sort.
  const [pinned, setPinned] = useState<string[]>([])

  // The render window resets whenever the list it windows changes shape. Adjusting it during
  // render, not in an effect, avoids a frame with the old count.
  const windowKey = `${filterText}|${sort}|${kind}|${density}`
  const [windowState, setWindowState] = useState({ key: windowKey, count: RENDER_WINDOW })
  if (windowState.key !== windowKey) setWindowState({ key: windowKey, count: RENDER_WINDOW })
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
  const orderedAssets = useStableAssetOrder(scopedAssets, sort, library.complete, pinned)
  const matchedAssets = useMemo(
    () =>
      orderedAssets.filter(
        (asset) => matchesKind(asset, effectiveKind) && matchesText(asset, needle),
      ),
    [orderedAssets, effectiveKind, needle],
  )
  const visibleAssets = matchedAssets.slice(0, visibleCount)
  const hasMore = matchedAssets.length > visibleAssets.length

  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  // The scroll viewport is the observer's root: a margin on the default root would only widen
  // the document viewport, not the ScrollArea that clips the sentinel.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore()
      },
      { root: viewport, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel, viewport, hasMore, showMore])

  const handleDrop = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setActionError(null)
    const asset = await upload.upload(file)
    if (!asset) return
    library.prepend(asset)
    setPinned((prev) => [asset.hash32, ...prev.filter((hash) => hash !== asset.hash32)])
    // The upload must be visible: a search or kind filter that would hide it is cleared.
    setFilterText((prev) => (matchesText(asset, prev.trim().toLowerCase()) ? prev : ''))
    setKind((prev) => (matchesKind(asset, prev) ? prev : 'all'))
  }

  const handleReject = (rejections: FileRejection[]) => {
    setActionError(rejections[0]?.errors[0]?.message ?? 'The file was rejected.')
  }

  /**
   * Runs a remove or restore; `failure` words its error, and the raw server message is for admins.
   * A non-admin's 403 from the API is the ownership refusal, so it says so (`refusal`) rather than
   * to retry. Restore shows only to admins, so it has none.
   */
  const changeVisibility = async (
    request: () => Promise<{ ok: boolean; status: number; error?: string }>,
    failure: string,
    refusal: string | null,
    onDone: () => void,
  ) => {
    setActionError(null)
    const fail = (serverMessage: string | undefined) =>
      setActionError(`${failure} ${(admin && serverMessage) || 'Try again.'}`)
    try {
      const result = await request()
      if (!result.ok) {
        if (refusal && result.status === 403 && !admin && !isNonApiResponse(result)) {
          setActionError(`${failure} ${refusal}`)
        } else {
          fail(result.error)
        }
        return
      }
      onDone()
    } catch (err) {
      fail(getErrorMessage(err))
    }
  }

  const handleRemove = (asset: AssetRecord) =>
    changeVisibility(
      () => client.assets.hide({ key: asset.hash32 }),
      `Couldn't remove ${asset.filename} from the library.`,
      'You can only remove files you uploaded. Ask an admin to remove it.',
      () => {
        if (showRemoved) library.replace({ ...asset, hidden: true })
        else library.remove(asset.hash32)
        announce(`Removed ${asset.filename} from library`)
      },
    )

  const handleRestore = (asset: AssetRecord) =>
    changeVisibility(
      () => client.assets.restore({ key: asset.hash32 }),
      `Couldn't restore ${asset.filename} to the library.`,
      null,
      () => {
        library.replace(withoutHidden(asset))
        announce(`Restored ${asset.filename} to library`)
      },
    )

  // A confirm, not an Undo: only an admin can restore, from the "Show removed files" view.
  const handleRemoveClick = (asset: AssetRecord) => {
    openConfirm({
      title: 'Remove from library',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            &ldquo;{asset.filename}&rdquo; will no longer be listed in the media library or offered
            when choosing an image. Entries that already use it keep working, including published
            and earlier versions of the site.
          </Text>
          <Text size="sm">
            {admin
              ? 'To restore it, turn on “Show removed files”, or upload it again.'
              : 'To restore it, upload it again or ask an admin.'}
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Remove from library', cancel: 'Cancel' },
      onConfirm: () => {
        void handleRemove(asset)
      },
    })
  }

  // `text` is shown; `announce` is the live-region wording, which changes only between phases so
  // a screen reader is not told every page's count.
  const loadStatus = ((): { text: React.ReactNode; announce: string } | null => {
    if (library.error || !library.firstPageLoaded) return null
    if (!library.complete) {
      return needle
        ? {
            text: `Searching ${fileCountLabel(kindAssets.length)} loaded so far…`,
            announce: 'Searching the files loaded so far…',
          }
        : {
            text: `Loaded ${fileCountLabel(kindAssets.length)}, loading more…`,
            announce: 'Loading more files…',
          }
    }
    // With no match, the empty state below says so.
    if (needle && matchedAssets.length > 0) {
      const total = kindAssets.length
      const text = `${matchedAssets.length} of ${total} ${total === 1 ? 'file matches' : 'files match'}`
      return { text, announce: text }
    }
    return null
  })()

  const kindNoun =
    effectiveKind === 'pdfs' ? 'PDFs' : effectiveKind === 'images' ? 'images' : 'files'
  const libraryEmpty = library.complete && scopedAssets.length === 0
  const emptyState = ((): React.ReactNode => {
    if (matchedAssets.length > 0) return null
    // A later page failed: say what the loaded part holds; the alert explains the rest.
    if (library.error && !library.complete) {
      if (!library.firstPageLoaded || kindAssets.length === 0) return null
      return needle
        ? `No ${kindNoun} match “${filterText.trim()}” among the ${fileCountLabel(kindAssets.length)} loaded.`
        : null
    }
    if (!library.complete) return null
    if (libraryEmpty) {
      return imageOnly
        ? 'No images yet. Drop an image above, or click there to choose one.'
        : 'No files yet. Drop a file above, or click there to choose one.'
    }
    if (needle) return `No ${kindNoun} match “${filterText.trim()}”.`
    return `No ${kindNoun} in the library.`
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
              onRemove={canChangeVisibility(asset) ? handleRemoveClick : undefined}
              onRestore={canChangeVisibility(asset) ? handleRestore : undefined}
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
            onRemove={canChangeVisibility(asset) ? handleRemoveClick : undefined}
            onRestore={canChangeVisibility(asset) ? handleRestore : undefined}
          />
        ))}
      </SimpleGrid>
    )
  }

  const listContent = (
    <>
      {!library.firstPageLoaded && !library.error && visibleAssets.length === 0 && (
        <MediaLibrarySkeleton density={density} />
      )}
      {visibleAssets.length > 0 && renderList()}
      {emptyState && (
        <Stack align="center" gap="xs" py="xl" data-testid="media-library-empty">
          <Text size="sm" c="dimmed" ta="center">
            {emptyState}
          </Text>
          <Group gap="xs" justify="center">
            {needle && (
              <Button variant="light" size="xs" onClick={clearSearch}>
                Clear search
              </Button>
            )}
            {kind !== 'all' && !libraryEmpty && (
              <Button variant="light" size="xs" onClick={() => setKind('all')}>
                Show all files
              </Button>
            )}
          </Group>
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
    // `h="100%"` bounds it in a fixed-height host (the MDX image dialog's library tab); `flex`
    // bounds it in the drawer's flex body.
    <Stack gap="sm" h="100%" style={{ flex: 1, minHeight: 0 }}>
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
                onClick={clearSearch}
              >
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          ) : null
        }
        ref={searchRef}
        value={filterText}
        onChange={(event) => setFilterText(event.currentTarget.value)}
        // Esc clears a search before it can close the drawer or modal. Mantine closes them from
        // a window capture listener that stopPropagation can't reach; it skips an event whose
        // target carries this attribute.
        data-mantine-stop-propagation={filterText ? 'true' : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && filterText) setFilterText('')
        }}
        data-testid="media-library-filter"
      />

      <Group justify="space-between" wrap="wrap" gap="xs">
        {imageOnly ? (
          <span />
        ) : (
          <Group gap="md" wrap="wrap">
            <SegmentedControl
              aria-label="File type"
              data={KIND_OPTIONS}
              value={kind}
              onChange={(value) =>
                setKind(KIND_OPTIONS.find((o) => o.value === value)?.value ?? 'all')
              }
              data-testid="media-library-kind"
            />
            {admin && mode === 'manage' && (
              <Switch
                label="Show removed files"
                checked={showRemoved}
                onChange={(event) => setShowRemoved(event.currentTarget.checked)}
                data-testid="media-library-show-removed"
              />
            )}
          </Group>
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

      {/* The line keeps its height when empty, so the list doesn't jump when loading ends. */}
      <Text component="div" size="xs" c="dimmed" mih={18}>
        {loadStatus && (
          <span aria-hidden="true" data-testid="media-library-load-status">
            {loadStatus.text}
          </span>
        )}
      </Text>
      <VisuallyHidden role="status" aria-live="polite">
        {loadStatus?.announce ?? ''}
      </VisuallyHidden>
      {/* Its own region, so a load or match status never masks it or announces it late. */}
      <VisuallyHidden role="status" aria-live="polite" data-testid="media-library-action-notice">
        {actionNotice && <span key={actionNotice.id}>{actionNotice.text}</span>}
      </VisuallyHidden>

      {library.error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" data-testid="media-library-error">
          <Stack gap={4}>
            <Text size="sm">
              {library.error.firstPage
                ? "Couldn't load the media library."
                : `Couldn't load the rest of the media library. Showing the ${fileCountLabel(scopedAssets.length)} loaded so far.`}
            </Text>
            {/* The raw server message is a diagnostic, shown to admins only. */}
            {isAdmin(userContext?.groups) && (
              <Text size="xs" c="dimmed">
                {library.error.message}
              </Text>
            )}
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
        <ScrollArea.Autosize mah="60vh" viewportRef={setViewport}>
          {listContent}
        </ScrollArea.Autosize>
      ) : (
        <ScrollArea style={{ flex: 1, minHeight: 200 }} viewportRef={setViewport}>
          {listContent}
        </ScrollArea>
      )}
    </Stack>
  )
}
