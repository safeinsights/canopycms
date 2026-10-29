import type { Meta, StoryObj } from '@storybook/react'

import { LazyEntryChangesDrawer } from './LazyEntryChangesDrawer'

const noop = () => {}

const meta: Meta<typeof LazyEntryChangesDrawer> = {
  title: 'Editor/LazyEntryChangesDrawer',
  component: LazyEntryChangesDrawer,
  parameters: { layout: 'fullscreen' },
  args: {
    opened: true,
    onClose: noop,
    base: 'main',
    subject: {
      logicalPath: 'content/docs/getting-started',
      status: 'modified',
      title: 'Getting started',
      fields: [],
    },
    state: { data: undefined, error: undefined, isValidating: false, reload: async () => {} },
  },
}

export default meta
type Story = StoryObj<typeof LazyEntryChangesDrawer>

/** The drawer's chunk failed to load: the crash fallback, in a drawer of its own. */
export const CrashFallback: Story = {
  args: { load: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) },
}
