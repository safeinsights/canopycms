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
