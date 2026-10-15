import type { Meta, StoryObj } from '@storybook/react'
import { EditorSidebar } from './EditorSidebar'

const meta: Meta<typeof EditorSidebar> = {
  title: 'Editor/EditorSidebar',
  component: EditorSidebar,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: 320, display: 'flex', justifyContent: 'flex-end' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    layout: 'side',
    highlightEnabled: false,
    onLayoutChange: () => {},
    onHighlightToggle: () => {},
    onMediaLibraryOpen: () => {},
    onSystemHealthOpen: () => {},
    onPermissionManagerOpen: () => {},
    onGroupManagerOpen: () => {},
    onLogoutClick: () => {},
  },
}

export default meta
type Story = StoryObj<typeof EditorSidebar>

export const Default: Story = {}

/** Highlights on, with preview marks naming no field: the count sits on the toggle. */
export const HighlightsWithInexactMarks: Story = {
  args: {
    highlightEnabled: true,
    previewInexactMarks: [{ path: 'hero.subtitle', nearest: 'hero' }, { path: 'sidebar' }],
  },
}

/** The Settings menu as an admin sees it: permissions, groups, media library, system health. */
export const SettingsMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-testid="settings-button"]')?.click()
  },
}

/** An editor's Settings menu: the admin items are not offered. */
export const SettingsMenuForEditor: Story = {
  args: {
    onPermissionManagerOpen: undefined,
    onGroupManagerOpen: undefined,
    onSystemHealthOpen: undefined,
  },
  play: SettingsMenuOpen.play,
}
