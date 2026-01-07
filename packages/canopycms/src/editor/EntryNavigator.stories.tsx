import type { Meta, StoryObj } from '@storybook/react'

import { EntryNavigator } from './EntryNavigator'

const meta: Meta<typeof EntryNavigator> = {
  title: 'Editor/EntryNavigator',
  component: EntryNavigator,
}

export default meta
type Story = StoryObj<typeof EntryNavigator>

const posts = [
  { id: 'posts/hello-world', label: 'Hello World', collection: 'posts' },
  { id: 'posts/mermaid-demo', label: 'Mermaid Demo', collection: 'posts' },
]

const entries = [{ id: 'home', label: 'Home', collection: 'home' }]

export const Grouped: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        selectedId="posts/hello-world"
        onSelect={(id) => alert(`Select ${id}`)}
        collections={[
          { id: 'home', label: 'Home', type: 'entry', entries: entries },
          {
            id: 'posts',
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
        selectedId="home"
        onSelect={(id) => alert(`Select ${id}`)}
      />
    </div>
  ),
}
