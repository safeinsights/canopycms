import { ActionIcon, Menu, Paper, Stack } from '@mantine/core'
import { MdAccountCircle, MdLogout, MdSettings } from 'react-icons/md'
import { PiColumnsDuotone, PiRowsDuotone } from 'react-icons/pi'
import { LuSquareDashed } from 'react-icons/lu'
import type { PaneLayout } from '../EditorPanes'

/**
 * Props for the EditorSidebar component.
 */
export interface EditorSidebarProps {
  /**
   * Current layout mode (side or stacked).
   */
  layout: PaneLayout

  /**
   * Whether field highlighting is enabled.
   */
  highlightEnabled: boolean

  /**
   * Width of the sidebar in pixels.
   */
  sidebarWidth: number

  /**
   * Height of the header in pixels (for positioning).
   */
  headerHeight: number

  /**
   * Height of the footer in pixels (for positioning).
   */
  footerHeight: number

  /**
   * Callback when layout changes.
   */
  onLayoutChange: (layout: PaneLayout) => void

  /**
   * Callback when highlight toggle is clicked.
   */
  onHighlightToggle: () => void

  /**
   * Callback when permission manager should be opened.
   */
  onPermissionManagerOpen: () => void

  /**
   * Callback when group manager should be opened.
   */
  onGroupManagerOpen: () => void

  /**
   * Custom account component to render (e.g., Clerk's UserButton).
   * If provided, replaces the default account button.
   */
  AccountComponent?: React.ComponentType

  /**
   * Callback when account button is clicked (if no AccountComponent provided).
   */
  onAccountClick?: () => void

  /**
   * Callback when logout button is clicked.
   */
  onLogoutClick?: () => void
}

/**
 * Sidebar component for the Editor.
 * Contains layout toggle, highlight toggle, settings menu, account button, and logout button.
 *
 * @example
 * ```tsx
 * <EditorSidebar
 *   layout={layout}
 *   highlightEnabled={highlightEnabled}
 *   sidebarWidth={60}
 *   headerHeight={60}
 *   footerHeight={40}
 *   onLayoutChange={setLayout}
 *   onHighlightToggle={() => setHighlightEnabled(!highlightEnabled)}
 *   onPermissionManagerOpen={() => setPermissionManagerOpen(true)}
 *   onGroupManagerOpen={() => setGroupManagerOpen(true)}
 * />
 * ```
 */
export function EditorSidebar({
  layout,
  highlightEnabled,
  sidebarWidth,
  headerHeight,
  footerHeight,
  onLayoutChange,
  onHighlightToggle,
  onPermissionManagerOpen,
  onGroupManagerOpen,
  AccountComponent,
  onAccountClick,
  onLogoutClick,
}: EditorSidebarProps) {
  return (
    <Paper
      withBorder
      shadow="sm"
      radius={0}
      style={{
        position: 'fixed',
        top: headerHeight,
        bottom: footerHeight,
        right: 0,
        width: sidebarWidth,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 6px',
        gap: 8,
      }}
    >
      <Stack gap="sm" align="center" style={{ width: '100%', paddingTop: 6 }}>
        <ActionIcon
          variant="subtle"
          size="lg"
          radius="md"
          aria-label="Toggle layout"
          onClick={() => onLayoutChange(layout === 'side' ? 'stacked' : 'side')}
        >
          {layout === 'side' ? <PiRowsDuotone size={18} /> : <PiColumnsDuotone size={18} />}
        </ActionIcon>

        <ActionIcon
          variant={highlightEnabled ? 'filled' : 'subtle'}
          color={highlightEnabled ? 'brand' : 'gray'}
          size="lg"
          radius="md"
          aria-pressed={highlightEnabled}
          aria-label="Toggle highlights"
          onClick={onHighlightToggle}
        >
          <LuSquareDashed size={18} />
        </ActionIcon>
      </Stack>
      <Stack gap="xs" align="center">
        <Menu shadow="md" width={200} position="left">
          <Menu.Target>
            <ActionIcon variant="subtle" size="lg" radius="md" aria-label="Settings">
              <MdSettings size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Settings</Menu.Label>
            <Menu.Item onClick={onPermissionManagerOpen}>Manage Permissions</Menu.Item>
            <Menu.Item onClick={onGroupManagerOpen}>Manage Groups</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        {/* Account section - use custom component or default buttons */}
        {AccountComponent ? (
          <AccountComponent />
        ) : (
          <>
            {onAccountClick && (
              <ActionIcon
                variant="subtle"
                size="lg"
                radius="md"
                aria-label="Account"
                onClick={onAccountClick}
              >
                <MdAccountCircle size={18} />
              </ActionIcon>
            )}
            {onLogoutClick && (
              <ActionIcon
                variant="subtle"
                size="lg"
                radius="md"
                aria-label="Sign out"
                onClick={onLogoutClick}
              >
                <MdLogout size={18} />
              </ActionIcon>
            )}
          </>
        )}
      </Stack>
    </Paper>
  )
}
