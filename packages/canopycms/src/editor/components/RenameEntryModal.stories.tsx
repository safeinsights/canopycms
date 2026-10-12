import type { Meta, StoryObj } from '@storybook/react'

import { RenameEntryModal } from './RenameEntryModal'

const meta: Meta<typeof RenameEntryModal> = {
  title: 'Editor/RenameEntryModal',
  component: RenameEntryModal,
}

export default meta
type Story = StoryObj<typeof RenameEntryModal>

const noop = async () => {}

export const Default: Story = {
  render: () => (
    <RenameEntryModal
      isOpen
      entryLabel="Hello world"
      currentSlug="hello-world"
      onSave={noop}
      onClose={() => {}}
      existingSlugs={new Set(['hello-world', 'goodbye'])}
      previewPath={(slug) => `/posts/${slug}`}
    />
  ),
}

export const NoPage: Story = {
  render: () => (
    <RenameEntryModal
      isOpen
      entryLabel="Site settings"
      currentSlug="settings"
      onSave={noop}
      onClose={() => {}}
    />
  ),
}

export const WithError: Story = {
  render: () => (
    <RenameEntryModal
      isOpen
      entryLabel="Hello world"
      currentSlug="hello-world"
      onSave={noop}
      onClose={() => {}}
      error="Rename failed: the branch changed. Reload and try again."
    />
  ),
}
