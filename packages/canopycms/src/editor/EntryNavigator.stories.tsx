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

const singletons = [{ id: 'home/singleton', label: 'Home', collection: 'home' }]

export const Grouped: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        selectedId="posts/hello-world"
        onSelect={(id) => alert(`Select ${id}`)}
        collections={[
          { id: 'home', label: 'Home', type: 'singleton', entries: singletons },
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
        items={[...singletons, ...posts]}
        selectedId="home/singleton"
        onSelect={(id) => alert(`Select ${id}`)}
      />
    </div>
  ),
}
