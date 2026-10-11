'use client'

import React from 'react'

import { ActionIcon, Group, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconFileTypePdf, IconPhotoOff, IconTrash } from '@tabler/icons-react'

import type { AssetRecord } from '../../api'
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
   * cannot hold another, so a selectable row renders no remove control.
   */
  onSelect?: (asset: AssetRecord) => void
  /** Present only where the viewer may remove the asset - renders the trash button. */
  onDelete?: (asset: AssetRecord) => void
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
  background: 'var(--mantine-color-gray-1)',
  overflow: 'hidden',
}

/** One asset as a row in the list layout: thumbnail, name, dimensions, size and upload date. */
export const AssetListRow: React.FC<AssetListRowProps> = ({
  asset,
  baseUrl,
  onSelect,
  onDelete,
}) => {
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
            color="var(--mantine-color-gray-5)"
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

  const removeButton = onDelete && (
    <Tooltip label="Remove from library">
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label={`Remove ${asset.filename} from library`}
        data-testid={`asset-row-delete-${asset.hash32}`}
        onClick={() => onDelete(asset)}
      >
        <IconTrash size={16} />
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
      {removeButton}
    </Group>
  )
}
