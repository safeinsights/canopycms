'use client'

import React from 'react'

import { ActionIcon, Badge, Group, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconEyeOff, IconFileTypePdf, IconPhotoOff, IconRestore } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
import { EDITOR_ACTIONS } from '../copy'
import { formatRelativeTime } from '../relative-time'
import { editorImageSrc } from './editor-image-src'
import { formatBytes } from './format-bytes'
import { useThumbnailFailure } from './useThumbnailFailure'

export interface AssetListRowProps {
  asset: AssetRecord
  /** `useAssetContext().baseUrl`, the authenticated raw route - see AssetContext. */
  baseUrl?: string
  /**
   * Present in picker mode - the whole row is then a button that selects the asset. A button
   * cannot hold another, so a selectable row renders no remove or restore control.
   */
  onSelect?: (asset: AssetRecord) => void
  /** Present only where the viewer may remove the asset from the library. */
  onRemove?: (asset: AssetRecord) => void
  /** Present only where the viewer may restore a removed (`hidden`) asset to the library. */
  onRestore?: (asset: AssetRecord) => void
}

const THUMBNAIL_SIZE = 40
const THUMBNAIL_WIDTH = 80

const rowStyle: React.CSSProperties = {
  width: '100%',
  padding: 6,
  border: '1px solid var(--mantine-color-default-border)',
  borderRadius: 'var(--mantine-radius-md)',
}

const thumbnailBoxStyle: React.CSSProperties = {
  width: THUMBNAIL_SIZE,
  height: THUMBNAIL_SIZE,
  flex: `0 0 ${THUMBNAIL_SIZE}px`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--mantine-radius-sm)',
  background: 'var(--canopy-surface-muted)',
  overflow: 'hidden',
}

/**
 * One asset as a row in the list layout: thumbnail, name, dimensions, size and upload date. A file
 * removed from the library (`hidden`) is badged "Removed" and offers Restore instead of Remove.
 */
export const AssetListRow: React.FC<AssetListRowProps> = ({
  asset,
  baseUrl,
  onSelect,
  onRemove,
  onRestore,
}) => {
  const removed = asset.hidden === true
  const thumbnailSrc = editorImageSrc(asset.src, baseUrl ?? '', { width: THUMBNAIL_WIDTH })
  const [thumbnailFailed, markThumbnailFailed] = useThumbnailFailure(thumbnailSrc)
  const hasDimensions = asset.width !== undefined && asset.height !== undefined

  const content = (
    <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
      <div style={thumbnailBoxStyle}>
        {asset.kind === 'pdf' ? (
          <IconFileTypePdf size={24} stroke={1.5} aria-hidden />
        ) : thumbnailFailed ? (
          <IconPhotoOff
            size={20}
            stroke={1.5}
            color="var(--mantine-color-dimmed)"
            data-testid={`asset-row-thumbnail-fallback-${asset.hash32}`}
            aria-label="Preview unavailable"
          />
        ) : (
          // Decorative: the filename beside it already names the row.
          <img
            src={thumbnailSrc}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={markThumbnailFailed}
          />
        )}
      </div>
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
        <Text size="sm" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
          {asset.filename}
        </Text>
      </Tooltip>
      {removed && (
        <Badge
          size="xs"
          color="gray"
          variant="light"
          style={{ flex: '0 0 auto' }}
          data-testid={`asset-row-removed-${asset.hash32}`}
        >
          Removed
        </Badge>
      )}
      {/* Below `sm` only the date stays beside the name, so the filename keeps its width. */}
      <Text size="xs" c="dimmed" w={84} ta="right" visibleFrom="sm" style={{ flex: '0 0 auto' }}>
        {hasDimensions ? `${asset.width} × ${asset.height}` : ''}
      </Text>
      <Text size="xs" c="dimmed" w={52} ta="right" visibleFrom="sm" style={{ flex: '0 0 auto' }}>
        {formatBytes(asset.size)}
      </Text>
      <Tooltip label={new Date(asset.uploadedAt).toLocaleString()}>
        <Text size="xs" c="dimmed" w={72} ta="right" style={{ flex: '0 0 auto' }}>
          {formatRelativeTime(asset.uploadedAt)}
        </Text>
      </Tooltip>
    </Group>
  )

  const action = removed
    ? onRestore && (
        <Tooltip label={`${EDITOR_ACTIONS.restore} to library`}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`${EDITOR_ACTIONS.restore} ${asset.filename} to library`}
            data-testid={`asset-row-restore-${asset.hash32}`}
            onClick={() => onRestore(asset)}
          >
            <IconRestore size={16} />
          </ActionIcon>
        </Tooltip>
      )
    : onRemove && (
        <Tooltip label="Remove from library">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Remove ${asset.filename} from library`}
            data-testid={`asset-row-remove-${asset.hash32}`}
            onClick={() => onRemove(asset)}
          >
            <IconEyeOff size={16} />
          </ActionIcon>
        </Tooltip>
      )

  if (onSelect) {
    return (
      <UnstyledButton
        onClick={() => onSelect(asset)}
        data-testid={`asset-row-${asset.hash32}`}
        style={rowStyle}
      >
        {content}
      </UnstyledButton>
    )
  }

  return (
    <Group gap="xs" wrap="nowrap" data-testid={`asset-row-${asset.hash32}`} style={rowStyle}>
      {content}
      {action}
    </Group>
  )
}
