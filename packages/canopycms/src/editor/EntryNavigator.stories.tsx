import type { Meta, StoryObj } from '@storybook/react'

import { EntryNavigator } from './EntryNavigator'

const meta: Meta<typeof EntryNavigator> = {
  title: 'Editor/EntryNavigator',
  component: EntryNavigator,
}

export default meta
type Story = StoryObj<typeof EntryNavigator>

const posts = [
  { path: 'posts/hello-world', label: 'Hello World', collection: 'posts' },
  { path: 'posts/mermaid-demo', label: 'Mermaid Demo', collection: 'posts' },
]

const entries = [{ path: 'home', label: 'Home', collection: 'home' }]

export const Grouped: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        selectedPath="posts/hello-world"
        onSelect={(id) => alert(`Select ${id}`)}
        collections={[
          { path: 'home', label: 'Home', type: 'entry', entries: entries },
          {
            path: 'posts',
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
