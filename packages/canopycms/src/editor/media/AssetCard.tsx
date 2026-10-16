'use client'

import React from 'react'

import { ActionIcon, Badge, Card, Text, Tooltip } from '@mantine/core'
import { IconEyeOff, IconFileTypePdf, IconPhotoOff, IconRestore } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { EDITOR_ACTIONS } from '../copy'
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
  /** Present only where the viewer may remove the asset from the library (manage mode). */
  onRemove?: (asset: AssetRecord) => void
  /** Present only where the viewer may restore a removed (`hidden`) asset to the library. */
  onRestore?: (asset: AssetRecord) => void
  /** `compact` shrinks the thumbnail and drops the date line. */
  density?: 'grid' | 'compact'
}

const THUMBNAIL_WIDTH = 160

/** Over the thumbnail, so opaque: the default fill. */
const overlayActionStyle: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  zIndex: 1,
}

/**
 * One thumbnail card in the MediaLibrary grid. PDFs have no image to preview, so they render a
 * file-type icon instead. A file removed from the library (`hidden`, listed only for an admin who
 * asked to see removed files) is badged "Removed" and offers Restore instead of Remove.
 */
export const AssetCard: React.FC<AssetCardProps> = ({
  asset,
  baseUrl,
  onSelect,
  onRemove,
  onRestore,
  density = 'grid',
}) => {
  const compact = density === 'compact'
  const removed = asset.hidden === true
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
      {!removed && onRemove && (
        <Tooltip label={`${EDITOR_ACTIONS.remove} from library`}>
          <ActionIcon
            variant="default"
            radius="xl"
            style={overlayActionStyle}
            aria-label={`${EDITOR_ACTIONS.remove} ${asset.filename} from library`}
            data-testid={`asset-card-remove-${asset.hash32}`}
            onClick={(event) => {
              event.stopPropagation()
              onRemove(asset)
            }}
          >
            <IconEyeOff size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {removed && onRestore && (
        <Tooltip label={`${EDITOR_ACTIONS.restore} to library`}>
          <ActionIcon
            variant="default"
            radius="xl"
            style={overlayActionStyle}
            aria-label={`${EDITOR_ACTIONS.restore} ${asset.filename} to library`}
            data-testid={`asset-card-restore-${asset.hash32}`}
            onClick={(event) => {
              event.stopPropagation()
              onRestore(asset)
            }}
          >
            <IconRestore size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {removed && (
        <Badge
          size="xs"
          color="gray"
          variant="light"
          style={{ position: 'absolute', top: 8, left: 8, zIndex: 1 }}
          data-testid={`asset-card-removed-${asset.hash32}`}
        >
          Removed
        </Badge>
      )}
      <Card.Section>
        {asset.kind === 'pdf' ? (
          <div
            style={{
              height: thumbnailHeight,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--canopy-surface-muted)',
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
              background: 'var(--canopy-surface-muted)',
            }}
          >
            <IconPhotoOff
              size={compact ? 20 : 28}
              stroke={1.5}
              color="var(--mantine-color-dimmed)"
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
