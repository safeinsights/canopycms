import type { Meta, StoryObj } from '@storybook/react'

import { EntryNavigator } from './EntryNavigator'
import { unsafeAsLogicalPath } from '../paths/test-utils'

const meta: Meta<typeof EntryNavigator> = {
  title: 'Editor/EntryNavigator',
  component: EntryNavigator,
}

export default meta
type Story = StoryObj<typeof EntryNavigator>

const posts = [
  {
    path: unsafeAsLogicalPath('posts/hello-world'),
    label: 'Hello World',
    collection: 'posts',
  },
  {
    path: unsafeAsLogicalPath('posts/mermaid-demo'),
    label: 'Mermaid Demo',
    collection: 'posts',
  },
]

const entries = [{ path: unsafeAsLogicalPath('home'), label: 'Home', collection: 'home' }]

export const Grouped: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        selectedPath="posts/hello-world"
        onSelect={(id) => alert(`Select ${id}`)}
        collections={[
          {
            path: unsafeAsLogicalPath('home'),
            label: 'Home',
            type: 'entry',
            entries: entries,
          },
          {
            path: unsafeAsLogicalPath('posts'),
            label: 'Posts',
            type: 'collection',
            entries: posts,
            onAdd: () => alert('Add post'),
          },
        ]}
      />
    </div>
  ),
}

export const FlatList: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        items={[...entries, ...posts]}
        selectedPath="home"
        onSelect={(id) => alert(`Select ${id}`)}
      />
    </div>
  ),
}
