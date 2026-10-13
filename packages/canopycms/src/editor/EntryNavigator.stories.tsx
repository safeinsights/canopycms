import type { Meta, StoryObj } from '@storybook/react'

import { EntryNavigator } from './EntryNavigator'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'

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

const noop = () => {}

/** The navigator at the drawer's content width, with long titles, nesting, markers and every menu. */
export const DrawerWidth: Story = {
  render: () => (
    <div
      style={{ width: 328, height: 520, border: '1px solid var(--mantine-color-default-border)' }}
    >
      <EntryNavigator
        selectedPath="content/guides/getting-started-with-a-very-long-guide-title"
        onSelect={noop}
        onDeleteEntry={noop}
        onRenameEntry={noop}
        onReorderEntry={noop}
        hiddenRootPath="content"
        dirtyPaths={new Set(['content/guides/data-access'])}
        collections={[
          {
            path: unsafeAsLogicalPath('content'),
            label: 'Content',
            type: 'collection',
            onAdd: noop,
            onAddSubCollection: noop,
            order: ['home00000001', 'guides000001', 'news00000001'],
            entries: [
              {
                path: unsafeAsLogicalPath('content/home'),
                label: 'Home — the welcome page for every visitor to the research platform',
                status: 'page',
                contentId: unsafeAsContentId('home00000001'),
              },
            ],
            children: [
              {
                path: unsafeAsLogicalPath('content/guides'),
                label: 'Guides and tutorials for researchers',
                type: 'collection',
                contentId: unsafeAsContentId('guides000001'),
                onAdd: noop,
                onEdit: noop,
                onAddSubCollection: noop,
                onDelete: noop,
                entries: [
                  {
                    path: unsafeAsLogicalPath(
                      'content/guides/getting-started-with-a-very-long-guide-title',
                    ),
                    label: 'Getting started with a very long guide title that never ends',
                    status: 'guide',
                    contentId: unsafeAsContentId('guide0000001'),
                  },
                  {
                    path: unsafeAsLogicalPath('content/guides/data-access'),
                    label: 'Data access',
                    status: 'guide',
                    contentId: unsafeAsContentId('guide0000002'),
                    conflictNotice: true,
                  },
                ],
                children: [
                  {
                    path: unsafeAsLogicalPath('content/guides/advanced'),
                    label: 'Advanced topics for people who work with sensitive data',
                    type: 'collection',
                    contentId: unsafeAsContentId('adv000000001'),
                    onAdd: noop,
                    entries: [
                      {
                        path: unsafeAsLogicalPath('content/guides/advanced/enclave'),
                        label: 'Working inside a secure enclave',
                        status: 'guide',
                        contentId: unsafeAsContentId('adv000000002'),
                      },
                    ],
                  },
                ],
              },
              {
                path: unsafeAsLogicalPath('content/news'),
                label: 'News',
                type: 'collection',
                contentId: unsafeAsContentId('news00000001'),
                onAdd: noop,
                onEdit: noop,
                onAddSubCollection: noop,
                onDelete: noop,
                entries: [
                  {
                    path: unsafeAsLogicalPath('content/news/launch'),
                    label: 'Launch announcement',
                    status: 'post',
                    contentId: unsafeAsContentId('news00000002'),
                    readOnly: true,
                  },
                ],
              },
            ],
          },
        ]}
      />
    </div>
  ),
}
