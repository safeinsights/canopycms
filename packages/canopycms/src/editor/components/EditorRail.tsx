'use client'

import { useRef, useState, type ReactElement, type Ref } from 'react'
import { ActionIcon, Menu, Stack, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { useMergedRef } from '@mantine/hooks'
import {
  IconActivity,
  IconExternalLink,
  IconFiles,
  IconGitBranch,
  IconInfoCircle,
  IconLogout,
  IconMessageCircle,
  IconPhoto,
  IconSearch,
  IconSettings,
  IconUserCircle,
} from '@tabler/icons-react'
import { ActivityRail, RailButton } from '../shell/ActivityRail'
import { useMenuItemFocusReturn } from '../utils/focus-return'
import { CANOPYCMS_VERSION } from '../../version'
import { EDITOR_ACTIONS } from '../copy'

const ABOUT_URL = 'https://github.com/safeinsights/canopycms'

export interface EditorRailProps {
  siteTitle: string
  /** Opens the site's first entry, which is also what the editor opens with no entry asked for. */
  onHomeOpen: () => void
  contentPanelOpen: boolean
  /** The content panel's element id, for `aria-controls`. */
  contentPanelId: string
  onContentToggle: () => void
  contentToggleRef?: Ref<HTMLButtonElement>
  onQuickOpen: () => void
  /** The quick open shortcut as the platform writes it, such as "⌘P". */
  quickOpenShortcut: string
  /** The same shortcut for `aria-keyshortcuts`, such as "Meta+P". */
  quickOpenKeys: string
  branchesOpen: boolean
  onBranchesOpen: () => void
  /** Without it, the Comments button is not offered (no branch, or a mode without comments). */
  onCommentsOpen?: () => void
  commentsOpen: boolean
  unresolvedCommentCount: number
  mediaLibraryOpen: boolean
  onMediaLibraryOpen: () => void
  mediaButtonRef?: Ref<HTMLButtonElement>
  /** Admin-only, like the other two below: each Settings item renders only when given. */
  onPermissionManagerOpen?: () => void
  onGroupManagerOpen?: () => void
  onSystemHealthOpen?: () => void
  /** Takes focus back when a panel opened from the Settings menu closes. */
  settingsToggleRef?: Ref<HTMLButtonElement>
  /** The adopter's account control, such as Clerk's UserButton; replaces the default buttons. */
  AccountComponent?: React.ComponentType
  onAccountClick?: () => void
  onLogoutClick?: () => void
}

/**
 * @internal Exported for tests. The Settings button and its menu of `items`; with none, no
 * button, since a menu that opens empty offers nothing.
 */
export function SettingsMenu({
  items,
  toggleRef,
}: {
  items: readonly ReactElement[]
  toggleRef?: Ref<HTMLButtonElement>
}) {
  const [opened, setOpened] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const mergedRef = useMergedRef(toggle, toggleRef)
  const menuFocus = useMenuItemFocusReturn(toggle)
  if (items.length === 0) return null
  return (
    <Menu
      shadow="md"
      width={220}
      position="right-end"
      opened={opened}
      onChange={setOpened}
      {...menuFocus.menu}
    >
      <Menu.Target>
        <RailButton
          railId="settings"
          label="Settings"
          icon={<IconSettings size={20} />}
          tooltipDisabled={opened}
          ref={mergedRef}
          data-testid="settings-button"
        />
      </Menu.Target>
      <Menu.Dropdown data-testid="settings-menu" {...menuFocus.dropdown}>
        {items}
      </Menu.Dropdown>
    </Menu>
  )
}

const monogram = (title: string): string => Array.from(title.trim())[0]?.toUpperCase() ?? '?'

/** The editor's activity rail: what `ActivityRail` lays out, wired to the editor's surfaces. */
export function EditorRail({
  siteTitle,
  onHomeOpen,
  contentPanelOpen,
  contentPanelId,
  onContentToggle,
  contentToggleRef,
  onQuickOpen,
  quickOpenShortcut,
  quickOpenKeys,
  branchesOpen,
  onBranchesOpen,
  onCommentsOpen,
  commentsOpen,
  unresolvedCommentCount,
  mediaLibraryOpen,
  onMediaLibraryOpen,
  mediaButtonRef,
  onPermissionManagerOpen,
  onGroupManagerOpen,
  onSystemHealthOpen,
  settingsToggleRef,
  AccountComponent,
  onAccountClick,
  onLogoutClick,
}: EditorRailProps) {
  const adminItems = [
    onPermissionManagerOpen && (
      <Menu.Item
        key="permissions"
        data-testid="settings-menu-permissions"
        onClick={onPermissionManagerOpen}
      >
        Manage permissions
      </Menu.Item>
    ),
    onGroupManagerOpen && (
      <Menu.Item key="groups" data-testid="settings-menu-groups" onClick={onGroupManagerOpen}>
        Manage groups
      </Menu.Item>
    ),
    onSystemHealthOpen && (
      <Menu.Item
        key="system-health"
        data-testid="settings-menu-system-health"
        leftSection={<IconActivity size={14} />}
        onClick={onSystemHealthOpen}
      >
        System health
      </Menu.Item>
    ),
  ].filter((item): item is ReactElement => !!item)
  // Every user gets the version, which bug reports need, so the menu is never empty today.
  const settingsItems: ReactElement[] = [
    ...(adminItems.length > 0
      ? [
          <Menu.Label key="admin">Settings</Menu.Label>,
          ...adminItems,
          <Menu.Divider key="divider" />,
        ]
      : []),
    <Menu.Label key="version" data-testid="settings-menu-version">
      {`CanopyCMS ${CANOPYCMS_VERSION}`}
    </Menu.Label>,
    <Menu.Item
      key="about"
      component="a"
      href={ABOUT_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="settings-menu-about"
      leftSection={<IconInfoCircle size={14} />}
      rightSection={<IconExternalLink size={14} aria-hidden />}
    >
      About CanopyCMS
      <VisuallyHidden component="span"> (opens in a new tab)</VisuallyHidden>
    </Menu.Item>,
  ]
  const commentsLabel =
    unresolvedCommentCount > 0 ? `Comments, ${unresolvedCommentCount} unresolved` : 'Comments'

  return (
    <ActivityRail
      top={
        <>
          <RailButton
            railId="home"
            label={`Open the first entry of ${siteTitle}`}
            icon={
              <Text component="span" fw={700} size="md" aria-hidden>
                {monogram(siteTitle)}
              </Text>
            }
            tinted
            data-testid="rail-home-button"
            onClick={onHomeOpen}
          />
          <RailButton
            railId="content"
            label="Content"
            icon={<IconFiles size={20} />}
            active={contentPanelOpen}
            aria-expanded={contentPanelOpen}
            aria-controls={contentPanelOpen ? contentPanelId : undefined}
            data-testid="content-panel-toggle"
            ref={contentToggleRef}
            onClick={onContentToggle}
          />
          <RailButton
            railId="search"
            label={EDITOR_ACTIONS.openEntry}
            shortcut={quickOpenShortcut}
            aria-keyshortcuts={quickOpenKeys}
            icon={<IconSearch size={20} />}
            aria-haspopup="dialog"
            data-testid="rail-search-button"
            onClick={onQuickOpen}
          />
          <RailButton
            railId="branches"
            label="Branches"
            icon={<IconGitBranch size={20} />}
            active={branchesOpen}
            aria-haspopup="dialog"
            data-testid="rail-branches-button"
            onClick={onBranchesOpen}
          />
          {onCommentsOpen && (
            <RailButton
              railId="comments"
              label={commentsLabel}
              icon={<IconMessageCircle size={20} />}
              active={commentsOpen}
              count={unresolvedCommentCount}
              countTestId="comments-unresolved-count"
              aria-haspopup="dialog"
              data-testid="comments-button"
              onClick={onCommentsOpen}
            />
          )}
          <RailButton
            railId="media"
            label="Media library"
            icon={<IconPhoto size={20} />}
            active={mediaLibraryOpen}
            aria-haspopup="dialog"
            data-testid="media-library-button"
            ref={mediaButtonRef}
            onClick={onMediaLibraryOpen}
          />
        </>
      }
      bottom={<SettingsMenu items={settingsItems} toggleRef={settingsToggleRef} />}
      account={
        AccountComponent ? (
          <AccountComponent />
        ) : onAccountClick || onLogoutClick ? (
          <Stack gap={6} align="center">
            {onAccountClick && (
              <Tooltip label="Account" position="right">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="lg"
                  radius="md"
                  aria-label="Account"
                  onClick={onAccountClick}
                >
                  <IconUserCircle size={20} />
                </ActionIcon>
              </Tooltip>
            )}
            {onLogoutClick && (
              <Tooltip label="Sign out" position="right">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="lg"
                  radius="md"
                  aria-label="Sign out"
                  onClick={onLogoutClick}
                >
                  <IconLogout size={20} />
                </ActionIcon>
              </Tooltip>
            )}
          </Stack>
        ) : undefined
      }
    />
  )
}
