import { useState } from 'react'
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

/**
 * Path rules refuse new entries in "Posts": its entries are locked, its "…" menu is gone, and one
 * line says why.
 */
export const AddRefused: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        onSelect={(id) => alert(`Select ${id}`)}
        collections={[
          {
            path: unsafeAsLogicalPath('posts'),
            label: 'Posts',
            type: 'collection',
            entries: posts.map((post) => ({ ...post, readOnly: true })),
            addRefused: true,
          },
        ]}
      />
    </div>
  ),
}

/** A branch that takes no writes: each row that would have a "…" menu draws a lock there on the hovered, focused or selected row. */
export const LockedBranch: Story = {
  render: () => (
    <div className="w-80">
      <EntryNavigator
        selectedPath="posts/hello-world"
        onSelect={(id) => alert(`Select ${id}`)}
        onDeleteEntry={() => {}}
        onRenameEntry={() => {}}
        readOnly
        readOnlyReason="This branch is in review. Withdraw it to make changes."
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
            onAdd: () => {},
          },
        ]}
      />
    </div>
  ),
}

const noop = () => {}

/** The navigator at the drawer's content width: long titles, types and routes, a singleton, a missing entry, nesting, markers and every menu. */
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
        filterShortcut={{ label: '⌘P', keys: 'Meta+P' }}
        collections={[
          {
            path: unsafeAsLogicalPath('content'),
            label: 'Content',
            type: 'collection',
            onAdd: noop,
            onAddSubCollection: noop,
            order: ['settings0001', 'home00000001', 'guides000001', 'news00000001'],
            entries: [
              {
                path: unsafeAsLogicalPath('content/settings'),
                label: 'Site settings',
                noPage: true,
                contentId: unsafeAsContentId('settings0001'),
              },
              {
                path: unsafeAsLogicalPath('content/home'),
                label: 'Home — the welcome page for every visitor to the research platform',
                status: 'Landing page with hero, highlights and calls to action',
                route: '/',
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
                    status: 'Guide',
                    route: '/guides/getting-started-with-a-very-long-guide-title',
                    contentId: unsafeAsContentId('guide0000001'),
                  },
                  {
                    path: unsafeAsLogicalPath('content/guides/data-access'),
                    label: 'Data access',
                    status: 'Guide',
                    route: '/guides/data-access',
                    contentId: unsafeAsContentId('guide0000002'),
                    conflictNotice: true,
                  },
                  {
                    path: unsafeAsLogicalPath('content/guides/retired'),
                    label: 'Retired guide',
                    status: 'Missing',
                    route: '/guides/retired',
                    missing: true,
                    contentId: unsafeAsContentId('guide0000003'),
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
                        status: 'Guide',
                        route: '/guides/advanced/enclave',
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
                    status: 'Post',
                    route: '/news/launch',
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

/** Changed on: only the unsaved entries, under the collections that hold them, and one not listed yet. */
export const Changed: Story = {
  render: function ChangedStory() {
    const [changedOnly, setChangedOnly] = useState(true)
    return (
      <div style={{ width: 328, height: 360 }}>
        <EntryNavigator
          onSelect={noop}
          changedOnly={changedOnly}
          onChangedOnlyChange={setChangedOnly}
          dirtyPaths={new Set(['posts/hello-world', 'home'])}
          unsavedCount={3}
          collections={[
            { path: unsafeAsLogicalPath('home'), label: 'Home', type: 'entry', entries },
            {
              path: unsafeAsLogicalPath('posts'),
              label: 'Posts',
              type: 'collection',
              entries: posts,
            },
          ]}
        />
      </div>
    )
  },
}

/** Changed on with nothing unsaved: it says so and offers All. */
export const ChangedNothingUnsaved: Story = {
  render: function ChangedNothingUnsavedStory() {
    const [changedOnly, setChangedOnly] = useState(true)
    return (
      <div style={{ width: 328, height: 240 }}>
        <EntryNavigator
          onSelect={noop}
          changedOnly={changedOnly}
          onChangedOnlyChange={setChangedOnly}
          collections={[
            {
              path: unsafeAsLogicalPath('posts'),
              label: 'Posts',
              type: 'collection',
              entries: posts,
            },
          ]}
        />
      </div>
    )
  },
}
