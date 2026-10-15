import type { Meta, StoryObj } from '@storybook/react'
import { EditorRail } from './EditorRail'

const noop = () => {}

const openSettings: Story['play'] = async ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[data-testid="settings-button"]')?.click()
}

const meta: Meta<typeof EditorRail> = {
  title: 'Editor/EditorRail',
  component: EditorRail,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: 520 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    siteTitle: 'Example Site',
    onHomeOpen: noop,
    contentPanelOpen: false,
    contentPanelId: 'content-panel',
    onContentToggle: noop,
    onQuickOpen: noop,
    quickOpenShortcut: '⌘P',
    branchesOpen: false,
    onBranchesOpen: noop,
    onCommentsOpen: noop,
    commentsOpen: false,
    unresolvedCommentCount: 0,
    mediaLibraryOpen: false,
    onMediaLibraryOpen: noop,
    onPermissionManagerOpen: noop,
    onGroupManagerOpen: noop,
    onSystemHealthOpen: noop,
    onLogoutClick: noop,
  },
}

export default meta
type Story = StoryObj<typeof EditorRail>

/** No unresolved comments: the Comments button carries no badge. */
export const Default: Story = {}

/** Three unresolved threads on the branch, and the content panel open. */
export const WithUnresolvedComments: Story = {
  args: { unresolvedCommentCount: 3, contentPanelOpen: true },
}

/** No branch yet, or a mode without comments: no Comments button. */
export const WithoutComments: Story = {
  args: { onCommentsOpen: undefined },
}

/** The Settings menu as an admin sees it: permissions, groups and system health, then About. */
export const SettingsMenuForAdmin: Story = {
  play: openSettings,
}

/** A non-admin's Settings menu: the admin items are not offered, only the version and About. */
export const SettingsMenuForNonAdmin: Story = {
  name: 'Non-admin: Settings shows only About/version',
  args: {
    onPermissionManagerOpen: undefined,
    onGroupManagerOpen: undefined,
    onSystemHealthOpen: undefined,
  },
  play: openSettings,
}
