'use client'

import React from 'react'

import { Drawer, Modal, Text, Title } from '@mantine/core'

import type { AssetRecord } from '../../api'
import { MediaLibraryBody } from './MediaLibraryBody'
import { focusReturnProps } from '../utils/focus-return'

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
  returnFocusTo?: () => HTMLElement | null
}

/**
 * One component, two presentations, sharing the same grid/list/upload/search/
 * delete core (MediaLibraryBody) - see
 * .claude/future-tasks/resolved/assets-media-system.md "MediaManager design".
 */
export const MediaLibrary: React.FC<MediaLibraryProps> = ({
  opened,
  onClose,
  mode,
  onSelect,
  returnFocusTo,
}) => {
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
      // The body fills the drawer and the library's own ScrollArea scrolls, so the toolbar stays put
      // and the list's IntersectionObserver sees a real clipping viewport.
      styles={{
        content: { display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }}
      overlayProps={{ blur: 2 }}
      data-testid="media-library-manage"
      {...focusReturnProps(returnFocusTo)}
    >
      <MediaLibraryBody opened={opened} mode="manage" />
    </Drawer>
  )
}
