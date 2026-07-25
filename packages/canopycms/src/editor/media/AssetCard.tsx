'use client'

import React, { useState } from 'react'

import { ActionIcon, Card, Text, Tooltip } from '@mantine/core'
import { IconFileTypePdf, IconPhotoOff, IconTrash } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { assetUrl } from '../../assets/asset-url'

export interface AssetCardProps {
  asset: AssetRecord
  /** `media.publicBaseUrl` - see AssetContext. */
  baseUrl?: string
  /** Present in picker mode - clicking the card selects the asset. */
  onSelect?: (asset: AssetRecord) => void
  /** Present only for admins in manage mode - renders the trash button. */
  onDelete?: (asset: AssetRecord) => void
}

const THUMBNAIL_WIDTH = 160

/**
 * One thumbnail card in the MediaLibrary grid. Raster and svg assets both go
 * through `assetUrl()` unmodified - for svg (a static, non-transform src)
 * `assetUrl` ignores the `width` option and just applies `baseUrl`, which is
 * exactly the behavior wanted here. PDFs have no image to preview, so they
 * render a file-type icon instead.
 */
export const AssetCard: React.FC<AssetCardProps> = ({ asset, baseUrl, onSelect, onDelete }) => {
  const uploadedDate = new Date(asset.uploadedAt).toLocaleDateString()
  const thumbnailSrc = assetUrl(asset, { width: THUMBNAIL_WIDTH, baseUrl })
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  // Reset the error state if the underlying asset/src changes, so a
  // previously-broken thumbnail gets another chance to load. Adjusting state
  // during render (rather than in a useEffect) avoids an extra render pass -
  // see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevThumbnailSrc, setPrevThumbnailSrc] = useState(thumbnailSrc)
  if (thumbnailSrc !== prevThumbnailSrc) {
    setPrevThumbnailSrc(thumbnailSrc)
    setThumbnailFailed(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(asset)
    }
  }

  return (
    <Card
      withBorder
      radius="md"
      padding="xs"
      data-testid={`asset-card-${asset.hash32}`}
      style={{ position: 'relative', cursor: onSelect ? 'pointer' : undefined }}
      onClick={onSelect ? () => onSelect(asset) : undefined}
      // Selection is otherwise a bare click handler on a non-interactive
      // element, unreachable from the keyboard - role="button" + tabIndex
      // makes it focusable and announced correctly, and onKeyDown mirrors
      // native <button> Enter/Space activation.
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? handleKeyDown : undefined}
    >
      {onDelete && (
        <ActionIcon
          variant="filled"
          color="red"
          size="sm"
          radius="xl"
          style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}
          aria-label={`Delete ${asset.filename}`}
          data-testid={`asset-card-delete-${asset.hash32}`}
          onClick={(event) => {
            event.stopPropagation()
            onDelete(asset)
          }}
        >
          <IconTrash size={14} />
        </ActionIcon>
      )}
      <Card.Section>
        {asset.kind === 'pdf' ? (
          <div
            style={{
              height: 100,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--mantine-color-gray-1)',
            }}
          >
            <IconFileTypePdf size={40} stroke={1.5} />
          </div>
        ) : thumbnailFailed ? (
          <div
            data-testid={`asset-card-thumbnail-fallback-${asset.hash32}`}
            style={{
              height: 100,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
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
            src={thumbnailSrc}
            alt={asset.filename}
            style={{ width: '100%', height: 100, objectFit: 'cover', display: 'block' }}
            onError={() => setThumbnailFailed(true)}
          />
        )}
      </Card.Section>
      <Tooltip label={asset.filename} openDelay={400}>
        <Text size="xs" fw={500} truncate mt={4}>
          {asset.slug}
        </Text>
      </Tooltip>
      <Text size="xs" c="dimmed">
        {uploadedDate}
      </Text>
    </Card>
  )
}

export default AssetCard
