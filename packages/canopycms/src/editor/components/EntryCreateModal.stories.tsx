import type { Meta, StoryObj } from '@storybook/react'

import { EntryCreateModal } from './EntryCreateModal'

const meta: Meta<typeof EntryCreateModal> = {
  title: 'Editor/EntryCreateModal',
  component: EntryCreateModal,
}

export default meta
type Story = StoryObj<typeof EntryCreateModal>

const noop = async () => {}

const previewPath = (slug: string) => `/posts/${slug || 'your-slug'}`

export const OneEntryType: Story = {
  render: () => (
    <EntryCreateModal
      isOpen
      collectionLabel="Posts"
      entryTypes={[{ name: 'post', label: 'Post', format: 'mdx', titleField: ['title'] }]}
      onCreate={noop}
      onClose={() => {}}
      existingSlugs={new Set(['hello-world'])}
      previewPath={previewPath}
    />
  ),
}

export const MultipleEntryTypes: Story = {
  render: () => (
    <EntryCreateModal
      isOpen
      collectionLabel="Posts"
      entryTypes={[
        { name: 'post', label: 'Post', format: 'mdx', default: true, titleField: ['title'] },
        { name: 'note', label: 'Note', format: 'md', titleField: ['hero', 'title'] },
        { name: 'link', label: 'Link', format: 'json' },
      ]}
      onCreate={noop}
      onClose={() => {}}
      existingSlugs={new Set(['hello-world'])}
      previewPath={previewPath}
    />
  ),
}

export const NoTitleField: Story = {
  render: () => (
    <EntryCreateModal
      isOpen
      collectionLabel="Settings"
      entryTypes={[{ name: 'settings', label: 'Settings', format: 'json' }]}
      onCreate={noop}
      onClose={() => {}}
    />
  ),
}

export const NoEntryTypes: Story = {
  render: () => (
    <EntryCreateModal
      isOpen
      collectionLabel="Guides"
      entryTypes={[]}
      onCreate={noop}
      onClose={() => {}}
    />
  ),
}
