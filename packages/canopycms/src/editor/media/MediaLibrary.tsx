'use client'

import React from 'react'

import { Drawer, Modal, Text, Title } from '@mantine/core'

import type { AssetRecord } from '../../api'
import { MediaLibraryBody } from './MediaLibraryBody'

export interface MediaLibraryProps {
  opened: boolean
  onClose: () => void
  /**
   * 'manage': right-side Drawer opened from the EditorSidebar Settings menu.
   * 'picker': Modal used by ImageField ("Browse library"/"Replace") and the
   * MDX image dialog's "From library" tab.
   */
  mode: 'manage' | 'picker'
  /** Required in picker mode - called with the chosen asset when a card is clicked. */
  onSelect?: (asset: AssetRecord) => void
}

/**
 * One component, two presentations, sharing the same grid/upload/filter/
 * pagination/delete core (MediaLibraryBody) - see
 * .claude/future-tasks/assets-media-system.md "MediaManager design".
 */
export const MediaLibrary: React.FC<MediaLibraryProps> = ({ opened, onClose, mode, onSelect }) => {
  if (mode === 'picker') {
    return (
      <Modal
        opened={opened}
        onClose={onClose}
        title="Media library"
        size="lg"
        overlayProps={{ blur: 2 }}
        data-testid="media-library-picker"
      >
        <MediaLibraryBody opened={opened} mode="picker" onSelect={onSelect} />
      </Modal>
    )
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      title={
        <div>
          <Title order={4}>Media library</Title>
          <Text size="xs" c="dimmed">
            Upload and manage images and PDFs
          </Text>
        </div>
      }
      padding="md"
      size={700}
      overlayProps={{ blur: 2 }}
      data-testid="media-library-manage"
    >
      <MediaLibraryBody opened={opened} mode="manage" />
    </Drawer>
  )
}

export default MediaLibrary
