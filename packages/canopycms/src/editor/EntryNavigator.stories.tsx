import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import { EntryNavigator, type BranchChangesView, type EntryFilter } from './EntryNavigator'
import type { BranchChangeEntry, BranchChangesData } from '../api/branch-changes'
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

/** Unsaved on: only the unsaved entries, under the collections that hold them, and one not listed yet. */
export const Unsaved: Story = {
  render: function UnsavedStory() {
    const [entryFilter, setEntryFilter] = useState<EntryFilter>('unsaved')
    return (
      <div style={{ width: 328, height: 360 }}>
        <EntryNavigator
          onSelect={noop}
          entryFilter={entryFilter}
          onEntryFilterChange={setEntryFilter}
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

/** Unsaved on with nothing unsaved: it says so and offers All. */
export const UnsavedNothingUnsaved: Story = {
  render: function UnsavedNothingUnsavedStory() {
    const [entryFilter, setEntryFilter] = useState<EntryFilter>('unsaved')
    return (
      <div style={{ width: 328, height: 240 }}>
        <EntryNavigator
          onSelect={noop}
          entryFilter={entryFilter}
          onEntryFilterChange={setEntryFilter}
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

const changeTree = [
  {
    path: unsafeAsLogicalPath('content'),
    label: 'Content',
    type: 'collection' as const,
    entries: [{ path: unsafeAsLogicalPath('content/home'), label: 'Home' }],
    children: [
      {
        path: unsafeAsLogicalPath('content/posts'),
        label: 'Posts',
        type: 'collection' as const,
        entries: [
          { path: unsafeAsLogicalPath('content/posts/hello-world'), label: 'Hello World' },
          { path: unsafeAsLogicalPath('content/posts/mermaid-demo'), label: 'Mermaid Demo' },
          { path: unsafeAsLogicalPath('content/posts/launch'), label: 'Launch day' },
        ],
      },
      {
        path: unsafeAsLogicalPath('content/docs'),
        label: 'Docs',
        type: 'collection' as const,
        entries: [{ path: unsafeAsLogicalPath('content/docs/setup'), label: 'Setup' }],
      },
    ],
  },
]

const change = (
  status: BranchChangeEntry['status'],
  logicalPath: string,
  extra: Partial<BranchChangeEntry> = {},
): BranchChangeEntry => ({
  status,
  logicalPath,
  contentId: 'aB3cD4eF5gH6',
  collectionPath: logicalPath.slice(0, logicalPath.lastIndexOf('/')),
  entryType: 'post',
  ...extra,
})

const changes: BranchChangesData = {
  base: 'main',
  entries: [
    change('modified', 'content/posts/hello-world'),
    change('added', 'content/posts/launch'),
    change('moved', 'content/docs/setup', { previousLogicalPath: 'content/setup' }),
    change('deleted', 'content/posts/old-faq', { title: 'Old FAQ' }),
  ],
  collections: [{ status: 'modified', logicalPath: 'content/docs' }],
  hiddenChanges: false,
}

/** The Content panel under Changed, given what the branch changes against its base. */
const ChangedStory = ({
  view,
  width = 328,
  initialFilter = 'changed',
  onShowDeletedChanges,
}: {
  onShowDeletedChanges?: (entry: BranchChangeEntry, label: string) => void
  /** Without it, the branch is the protected base, which offers no Changed. */
  view?: Omit<BranchChangesView, 'base' | 'onRetry'>
  width?: number
  initialFilter?: EntryFilter
}) => {
  const [entryFilter, setEntryFilter] = useState<EntryFilter>(initialFilter)
  return (
    <div style={{ width, height: 420 }}>
      <EntryNavigator
        onSelect={noop}
        collections={changeTree}
        hiddenRootPath="content"
        dirtyPaths={new Set(['content/posts/hello-world'])}
        unsavedCount={1}
        entryFilter={entryFilter}
        onEntryFilterChange={setEntryFilter}
        branchChanges={view && { base: 'main', onRetry: noop, ...view }}
        onShowDeletedChanges={onShowDeletedChanges}
      />
    </div>
  )
}

/** Changed: markers on each row, the unsaved dot kept, deleted entries beneath. */
export const Changed: Story = {
  render: () => <ChangedStory view={{ data: changes }} />,
}

/** Changed where each deleted entry is a button opening its changes. */
export const ChangedDeletedOpensChanges: Story = {
  render: () => <ChangedStory view={{ data: changes }} onShowDeletedChanges={noop} />,
}

/** Changed while the first load runs: skeleton rows, and no count. */
export const ChangedLoading: Story = {
  render: () => <ChangedStory view={{}} />,
}

/** Changed with nothing differing from the base. */
export const ChangedEmpty: Story = {
  render: () => <ChangedStory view={{ data: { ...changes, entries: [], collections: [] } }} />,
}

/** Changed whose reload failed, keeping what loaded before. */
export const ChangedError: Story = {
  render: () => (
    <ChangedStory view={{ data: changes, error: { kind: 'failed', message: 'HTTP 500' } }} />
  ),
}

/** Changed while the worker syncs the branch with its base (a 409). */
export const ChangedSyncing: Story = {
  render: () => <ChangedStory view={{ error: { kind: 'syncing' } }} />,
}

/** Changed with some changes in entries this user can't read. */
export const ChangedHidden: Story = {
  render: () => <ChangedStory view={{ data: { ...changes, hiddenChanges: true } }} />,
}

/** Changed for a branch that shares no history with its base. */
export const ChangedBaseUnavailable: Story = {
  render: () => (
    <ChangedStory
      view={{ data: { ...changes, entries: [], collections: [], baseUnavailable: true } }}
    />
  ),
}

/** Changed for an admin: other changed files behind Details. */
export const ChangedOtherFiles: Story = {
  render: () => (
    <ChangedStory view={{ data: { ...changes, otherFiles: ['README.md', 'src/site.ts'] } }} />
  ),
}

/** The protected base branch: All and Unsaved only, nothing to compare. */
export const ProtectedBase: Story = {
  render: () => <ChangedStory initialFilter="all" />,
}

/** Changed with rows the tree can't draw: an entry the list doesn't hold yet, the hidden root's settings. */
export const ChangedNotInTree: Story = {
  render: () => (
    <ChangedStory
      view={{
        data: {
          ...changes,
          entries: [...changes.entries, change('added', 'content/posts/brand-new-post')],
          collections: [{ status: 'modified', logicalPath: 'content' }],
        },
      }}
    />
  ),
}

/** Changed in a 240px panel: counts, markers and the deleted section at their narrowest. */
export const ChangedNarrow: Story = {
  render: () => <ChangedStory width={240} view={{ data: changes }} />,
}

/** Changed with nothing differing yet, while an entry is unsaved. */
export const ChangedEmptyWithUnsaved: Story = {
  render: () => <ChangedStory view={{ data: { ...changes, entries: [], collections: [] } }} />,
}

/** Retry working after a failed reload. */
export const ChangedRetrying: Story = {
  render: () => (
    <ChangedStory
      view={{ data: changes, error: { kind: 'failed', message: 'HTTP 503' }, retrying: true }}
    />
  ),
}
