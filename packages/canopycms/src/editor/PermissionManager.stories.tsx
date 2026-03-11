import type { Meta, StoryObj } from '@storybook/react'
import { PermissionManager } from './PermissionManager'
import type { PathPermission } from '../config'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import type { EditorCollection } from './Editor'
import { unsafeAsPermissionPath } from '../authorization/test-utils'
import { unsafeAsLogicalPath } from '../paths/test-utils'

const meta: Meta<typeof PermissionManager> = {
  title: 'Editor/PermissionManager',
  component: PermissionManager,
}

export default meta
type Story = StoryObj<typeof PermissionManager>

// Mock collections using EditorCollection structure
const mockCollections: EditorCollection[] = [
  {
    path: unsafeAsLogicalPath('content/posts'),
    name: 'posts',
    label: 'Posts',
    format: 'mdx',
    type: 'collection',
    entryTypes: [
      {
        name: 'post',
        label: 'Post',
        format: 'mdx',
      },
    ],
  },
  {
    path: unsafeAsLogicalPath('content/pages'),
    name: 'pages',
    label: 'Pages',
    format: 'mdx',
    type: 'collection',
    entryTypes: [
      {
        name: 'page',
        label: 'Page',
        format: 'mdx',
      },
    ],
  },
]

// Mock permissions
const mockPermissions: PathPermission[] = [
  {
    path: unsafeAsPermissionPath('content/posts/**'),
    edit: { allowedGroups: ['editors', 'content-team'] },
  },
  {
    path: unsafeAsPermissionPath('content/pages/**'),
    edit: { allowedUsers: ['alice'], allowedGroups: ['marketing'] },
  },
]

// Mock groups
const mockGroups: GroupMetadata[] = [
  { id: 'editors', name: 'Editors', memberCount: 12 },
  { id: 'content-team', name: 'Content Team', memberCount: 8 },
  { id: 'marketing', name: 'Marketing', memberCount: 15 },
  { id: 'engineering', name: 'Engineering', memberCount: 25 },
  { id: 'managers', name: 'Managers', memberCount: 5 },
  { id: 'customer-support', name: 'Customer Support', memberCount: 10 },
]

// Mock user search results
const mockUserSearchResults: UserSearchResult[] = [
  { id: 'alice', name: 'Alice Johnson', email: 'alice@example.com' },
  { id: 'bob', name: 'Bob Smith', email: 'bob@example.com' },
  { id: 'charlie', name: 'Charlie Brown', email: 'charlie@example.com' },
  { id: 'diana', name: 'Diana Prince', email: 'diana@example.com' },
]

const mockSearchUsers = async (query: string, limit?: number): Promise<UserSearchResult[]> => {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Filter mock results
  const filtered = mockUserSearchResults.filter(
    (u) =>
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.email.toLowerCase().includes(query.toLowerCase()),
  )

  return limit ? filtered.slice(0, limit) : filtered
}

const mockListGroups = async (): Promise<GroupMetadata[]> => {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 300))
  return mockGroups
}

const mockSave = async (permissions: PathPermission[]): Promise<void> => {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 1000))
  console.log('Saving permissions:', permissions)
}

export const Default: Story = {
  args: {
    collections: mockCollections,
    permissions: mockPermissions,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const Empty: Story = {
  args: {
    collections: mockCollections,
    permissions: [],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const ReadOnly: Story = {
  args: {
    collections: mockCollections,
    permissions: mockPermissions,
    canEdit: false,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const Loading: Story = {
  args: {
    collections: mockCollections,
    permissions: [],
    canEdit: true,
    loading: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const WithInheritance: Story = {
  args: {
    collections: mockCollections,
    permissions: [
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedGroups: ['managers'] },
      },
      {
        path: unsafeAsPermissionPath('content/posts/**'),
        edit: { allowedGroups: ['editors'], allowedUsers: ['alice'] },
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const ComplexPermissions: Story = {
  args: {
    collections: mockCollections,
    permissions: [
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedGroups: ['managers'] },
      },
      {
        path: unsafeAsPermissionPath('content/posts/**'),
        edit: { allowedGroups: ['editors', 'content-team'], allowedUsers: ['alice', 'bob'] },
      },
      {
        path: unsafeAsPermissionPath('content/pages/**'),
        edit: { allowedUsers: ['alice'], allowedGroups: ['marketing'] },
      },
      {
        path: unsafeAsPermissionPath('content/about.md'),
        edit: { allowedUsers: ['diana'] },
      },
      {
        path: unsafeAsPermissionPath('content/settings.json'),
        edit: { allowedGroups: ['engineering'] },
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

const largeCollections: EditorCollection[] = [
  {
    path: unsafeAsLogicalPath('content/posts'),
    name: 'posts',
    label: 'Posts',
    format: 'mdx',
    type: 'collection',
    entryTypes: [{ name: 'post', label: 'Post', format: 'mdx' }],
  },
  {
    path: unsafeAsLogicalPath('content/pages'),
    name: 'pages',
    label: 'Pages',
    format: 'mdx',
    type: 'collection',
    entryTypes: [{ name: 'page', label: 'Page', format: 'mdx' }],
  },
  {
    path: unsafeAsLogicalPath('content/products'),
    name: 'products',
    label: 'Products',
    format: 'json',
    type: 'collection',
    entryTypes: [{ name: 'product', label: 'Product', format: 'json' }],
  },
  {
    path: unsafeAsLogicalPath('content/categories'),
    name: 'categories',
    label: 'Categories',
    format: 'json',
    type: 'collection',
    entryTypes: [{ name: 'category', label: 'Category', format: 'json' }],
  },
  {
    path: unsafeAsLogicalPath('content/authors'),
    name: 'authors',
    label: 'Authors',
    format: 'json',
    type: 'collection',
    entryTypes: [{ name: 'author', label: 'Author', format: 'json' }],
  },
]

export const LargeSchema: Story = {
  args: {
    collections: largeCollections,
    contentTree: {
      path: 'content',
      name: 'content',
      type: 'folder',
      children: [
        {
          path: 'content/posts',
          name: 'posts',
          type: 'folder',
          children: [
            {
              path: 'content/posts/getting-started.mdx',
              name: 'getting-started.mdx',
              type: 'file',
            },
            {
              path: 'content/posts/advanced-features.mdx',
              name: 'advanced-features.mdx',
              type: 'file',
            },
            { path: 'content/posts/best-practices.mdx', name: 'best-practices.mdx', type: 'file' },
          ],
        },
        {
          path: 'content/pages',
          name: 'pages',
          type: 'folder',
          children: [
            { path: 'content/pages/home.mdx', name: 'home.mdx', type: 'file' },
            { path: 'content/pages/pricing.mdx', name: 'pricing.mdx', type: 'file' },
          ],
        },
        {
          path: 'content/products',
          name: 'products',
          type: 'folder',
          children: [
            { path: 'content/products/pro-plan.json', name: 'pro-plan.json', type: 'file' },
            { path: 'content/products/enterprise.json', name: 'enterprise.json', type: 'file' },
          ],
        },
      ],
    },
    permissions: [
      { path: unsafeAsPermissionPath('content/posts/**'), edit: { allowedGroups: ['editors'] } },
      {
        path: unsafeAsPermissionPath('content/posts/getting-started.mdx'),
        edit: { allowedUsers: ['alice', 'bob'] },
      },
      { path: unsafeAsPermissionPath('content/pages/**'), edit: { allowedGroups: ['marketing'] } },
      {
        path: unsafeAsPermissionPath('content/products/**'),
        edit: { allowedGroups: ['engineering'] },
      },
      {
        path: unsafeAsPermissionPath('content/categories/**'),
        edit: { allowedGroups: ['content-team'] },
      },
      { path: unsafeAsPermissionPath('content/authors/**'), edit: { allowedUsers: ['alice'] } },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const NoAuthPlugin: Story = {
  args: {
    collections: mockCollections,
    permissions: mockPermissions,
    canEdit: true,
    onSave: mockSave,
    // No onSearchUsers or onListGroups - auth plugin not configured
    onClose: () => console.log('Close clicked'),
  },
}

export const SaveError: Story = {
  args: {
    collections: mockCollections,
    permissions: mockPermissions,
    canEdit: true,
    onSave: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      throw new Error('Failed to save: Network error')
    },
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const GroupLoadError: Story = {
  args: {
    collections: mockCollections,
    permissions: mockPermissions,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      throw new Error('Failed to load groups')
    },
    onClose: () => console.log('Close clicked'),
  },
}

export const ManyPermissionsOnNode: Story = {
  args: {
    collections: mockCollections,
    permissions: [
      {
        path: unsafeAsPermissionPath('content/posts/**'),
        edit: {
          allowedGroups: ['editors', 'content-team', 'marketing', 'managers', 'customer-support'],
          allowedUsers: ['alice', 'bob', 'charlie', 'diana'],
        },
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const LongNames: Story = {
  args: {
    collections: mockCollections,
    permissions: [
      {
        path: unsafeAsPermissionPath('content/posts/**'),
        edit: {
          allowedGroups: ['very-long-group-name-that-might-cause-layout-issues'],
          allowedUsers: ['user-with-an-extremely-long-email-address@verylongdomain.example.com'],
        },
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const DeepNesting: Story = {
  args: {
    collections: mockCollections,
    contentTree: {
      path: 'content',
      name: 'content',
      type: 'folder',
      children: [
        {
          path: 'content/posts',
          name: 'posts',
          type: 'folder',
          children: [
            {
              path: 'content/posts/2024',
              name: '2024',
              type: 'folder',
              children: [
                {
                  path: 'content/posts/2024/january',
                  name: 'january',
                  type: 'folder',
                  children: [
                    {
                      path: 'content/posts/2024/january/week1.mdx',
                      name: 'week1.mdx',
                      type: 'file',
                    },
                    {
                      path: 'content/posts/2024/january/week2.mdx',
                      name: 'week2.mdx',
                      type: 'file',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    permissions: [
      {
        path: unsafeAsPermissionPath('content/posts/2024/january/**'),
        edit: { allowedGroups: ['editors'] },
      },
      {
        path: unsafeAsPermissionPath('content/posts/2024/january/week1.mdx'),
        edit: { allowedUsers: ['alice'] },
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const PermissionOverrides: Story = {
  args: {
    collections: mockCollections,
    permissions: [
      // Parent folder has managers access
      { path: unsafeAsPermissionPath('content/**'), edit: { allowedGroups: ['managers'] } },
      // Child folder overrides with editors
      { path: unsafeAsPermissionPath('content/posts/**'), edit: { allowedGroups: ['editors'] } },
      // Specific file overrides with specific user
      {
        path: unsafeAsPermissionPath('content/posts/sensitive-post.mdx'),
        edit: { allowedUsers: ['alice'] },
      },
    ],
    contentTree: {
      path: 'content',
      name: 'content',
      type: 'folder',
      children: [
        {
          path: 'content/posts',
          name: 'posts',
          type: 'folder',
          children: [
            { path: 'content/posts/public-post.mdx', name: 'public-post.mdx', type: 'file' },
            { path: 'content/posts/sensitive-post.mdx', name: 'sensitive-post.mdx', type: 'file' },
          ],
        },
      ],
    },
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}
