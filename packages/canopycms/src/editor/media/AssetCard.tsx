'use client'

import React from 'react'

import { ActionIcon, Card, Text, Tooltip } from '@mantine/core'
import { IconFileTypePdf, IconPhotoOff, IconTrash } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { formatRelativeTime } from '../relative-time'
import { editorImageSrc } from './editor-image-src'
import { CARD_THUMBNAIL_HEIGHT } from './media-library-view'
import { useThumbnailFailure } from './useThumbnailFailure'

export interface AssetCardProps {
  asset: AssetRecord
  /** `useAssetContext().baseUrl`, the authenticated raw route - see AssetContext. */
  baseUrl?: string
  /** Present in picker mode - clicking the card selects the asset. */
  onSelect?: (asset: AssetRecord) => void
  /** Present only where the viewer may remove the asset (manage mode) - renders the trash button. */
  onDelete?: (asset: AssetRecord) => void
  /** `compact` shrinks the thumbnail and drops the date line. */
  density?: 'grid' | 'compact'
}

const THUMBNAIL_WIDTH = 160

/**
 * One thumbnail card in the MediaLibrary grid. PDFs have no image to preview, so they render a
 * file-type icon instead.
 */
export const AssetCard: React.FC<AssetCardProps> = ({
  asset,
  baseUrl,
  onSelect,
  onDelete,
  density = 'grid',
}) => {
  const compact = density === 'compact'
  const thumbnailHeight = CARD_THUMBNAIL_HEIGHT[density]
  const thumbnailSrc = editorImageSrc(asset.src, baseUrl ?? '', { width: THUMBNAIL_WIDTH })
  const [thumbnailFailed, markThumbnailFailed] = useThumbnailFailure(thumbnailSrc)

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
      // Mantine draws its focus ring only on its own controls or this class; a bare Card gets none.
      className={onSelect ? 'mantine-focus-auto' : undefined}
      // The name a picker card announces; the thumbnail, filename and date would repeat the name.
      aria-label={onSelect ? `Select ${asset.filename}` : undefined}
    >
      {onDelete && (
        <Tooltip label="Remove from library">
          <ActionIcon
            variant="filled"
            color="red"
            radius="xl"
            style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}
            aria-label={`Remove ${asset.filename} from library`}
            data-testid={`asset-card-delete-${asset.hash32}`}
            onClick={(event) => {
              event.stopPropagation()
              onDelete(asset)
            }}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      <Card.Section>
        {asset.kind === 'pdf' ? (
          <div
            style={{
              height: thumbnailHeight,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--mantine-color-gray-1)',
            }}
          >
            <IconFileTypePdf size={compact ? 28 : 40} stroke={1.5} />
          </div>
        ) : thumbnailFailed ? (
          <div
            data-testid={`asset-card-thumbnail-fallback-${asset.hash32}`}
            style={{
              height: thumbnailHeight,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              background: 'var(--mantine-color-gray-1)',
            }}
          >
            <IconPhotoOff
              size={compact ? 20 : 28}
              stroke={1.5}
              color="var(--mantine-color-gray-5)"
            />
            <Text size="xs" c="dimmed">
              Preview unavailable
            </Text>
          </div>
        ) : (
          <img
            src={thumbnailSrc}
            alt={asset.filename}
            style={{ width: '100%', height: thumbnailHeight, objectFit: 'cover', display: 'block' }}
            onError={markThumbnailFailed}
          />
        )}
      </Card.Section>
      <Tooltip
        multiline
        w={260}
        openDelay={400}
        label={
          <>
            <div style={{ overflowWrap: 'anywhere' }}>{asset.filename}</div>
            <div style={{ overflowWrap: 'anywhere' }}>Slug: {asset.slug}</div>
          </>
        }
      >
        <Text size="xs" fw={500} truncate mt={4}>
          {asset.filename}
        </Text>
      </Tooltip>
      {!compact && (
        <Tooltip label={new Date(asset.uploadedAt).toLocaleString()}>
          <Text size="xs" c="dimmed" w="fit-content">
            {formatRelativeTime(asset.uploadedAt)}
          </Text>
        </Tooltip>
      )}
    </Card>
  )
}
