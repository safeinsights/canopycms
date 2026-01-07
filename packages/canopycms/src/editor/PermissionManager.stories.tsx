import type { Meta, StoryObj } from '@storybook/react'
import { PermissionManager } from './PermissionManager'
import type { PathPermission } from '../config'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import type { CanopyConfig } from '../config'

const meta: Meta<typeof PermissionManager> = {
  title: 'Editor/PermissionManager',
  component: PermissionManager,
}

export default meta
type Story = StoryObj<typeof PermissionManager>

// Mock schema
const mockSchema: CanopyConfig['schema'] = [
  {
    type: 'collection',
    name: 'Posts',
    path: 'posts',
    format: 'mdx',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'content', type: 'markdown' },
    ],
  },
  {
    type: 'collection',
    name: 'Pages',
    path: 'pages',
    format: 'mdx',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'markdown' },
    ],
  },
  {
    type: 'entry',
    name: 'About',
    path: 'about.md',
    format: 'mdx',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'bio', type: 'markdown' },
    ],
  },
  {
    type: 'entry',
    name: 'Settings',
    path: 'settings.json',
    format: 'json',
    fields: [{ name: 'siteName', type: 'string' }],
  },
]

// Mock permissions
const mockPermissions: PathPermission[] = [
  {
    path: 'content/posts/**',
    edit: { allowedGroups: ['editors', 'content-team'] },
  },
  {
    path: 'content/pages/**',
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
      u.email.toLowerCase().includes(query.toLowerCase())
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
    schema: mockSchema,
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
    schema: mockSchema,
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
    schema: mockSchema,
    permissions: mockPermissions,
    canEdit: false,
    onSearchUsers: mockSearchUsers,
    onListGroups: mockListGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const Loading: Story = {
  args: {
    schema: mockSchema,
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
    schema: mockSchema,
    permissions: [
      {
        path: 'content/**',
        edit: { allowedGroups: ['managers'] },
      },
      {
        path: 'content/posts/**',
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
    schema: mockSchema,
    permissions: [
      {
        path: 'content/**',
        edit: { allowedGroups: ['managers'] },
      },
      {
        path: 'content/posts/**',
        edit: { allowedGroups: ['editors', 'content-team'], allowedUsers: ['alice', 'bob'] },
      },
      {
        path: 'content/pages/**',
        edit: { allowedUsers: ['alice'], allowedGroups: ['marketing'] },
      },
      {
        path: 'content/about.md',
        edit: { allowedUsers: ['diana'] },
      },
      {
        path: 'content/settings.json',
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

export const LargeSchema: Story = {
  args: {
    schema: [
      {
        type: 'collection',
        name: 'Posts',
        path: 'posts',
        format: 'mdx',
        fields: [{ name: 'title', type: 'string' }],
      },
      {
        type: 'collection',
        name: 'Pages',
        path: 'pages',
        format: 'mdx',
        fields: [{ name: 'title', type: 'string' }],
      },
      {
        type: 'collection',
        name: 'Products',
        path: 'products',
        format: 'json',
        fields: [{ name: 'name', type: 'string' }],
      },
      {
        type: 'collection',
        name: 'Categories',
        path: 'categories',
        format: 'json',
        fields: [{ name: 'name', type: 'string' }],
      },
      {
        type: 'collection',
        name: 'Authors',
        path: 'authors',
        format: 'json',
        fields: [{ name: 'name', type: 'string' }],
      },
      {
        type: 'entry',
        name: 'About',
        path: 'about.md',
        format: 'mdx',
        fields: [{ name: 'title', type: 'string' }],
      },
      {
        type: 'entry',
        name: 'Contact',
        path: 'contact.md',
        format: 'mdx',
        fields: [{ name: 'title', type: 'string' }],
      },
      {
        type: 'entry',
        name: 'Settings',
        path: 'settings.json',
        format: 'json',
        fields: [{ name: 'siteName', type: 'string' }],
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
            { path: 'content/posts/getting-started.mdx', name: 'getting-started.mdx', type: 'file' },
            { path: 'content/posts/advanced-features.mdx', name: 'advanced-features.mdx', type: 'file' },
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
      { path: 'content/posts/**', edit: { allowedGroups: ['editors'] } },
      { path: 'content/posts/getting-started.mdx', edit: { allowedUsers: ['alice', 'bob'] } },
      { path: 'content/pages/**', edit: { allowedGroups: ['marketing'] } },
      { path: 'content/products/**', edit: { allowedGroups: ['engineering'] } },
      { path: 'content/categories/**', edit: { allowedGroups: ['content-team'] } },
      { path: 'content/authors/**', edit: { allowedUsers: ['alice'] } },
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
    schema: mockSchema,
    permissions: mockPermissions,
    canEdit: true,
    onSave: mockSave,
    // No onSearchUsers or onListGroups - auth plugin not configured
    onClose: () => console.log('Close clicked'),
  },
}

export const SaveError: Story = {
  args: {
    schema: mockSchema,
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
    schema: mockSchema,
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
    schema: mockSchema,
    permissions: [
      {
        path: 'content/posts/**',
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
    schema: mockSchema,
    permissions: [
      {
        path: 'content/posts/**',
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
    schema: mockSchema,
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
                    { path: 'content/posts/2024/january/week1.mdx', name: 'week1.mdx', type: 'file' },
                    { path: 'content/posts/2024/january/week2.mdx', name: 'week2.mdx', type: 'file' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    permissions: [
      { path: 'content/posts/2024/january/**', edit: { allowedGroups: ['editors'] } },
      { path: 'content/posts/2024/january/week1.mdx', edit: { allowedUsers: ['alice'] } },
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
    schema: mockSchema,
    permissions: [
      // Parent folder has managers access
      { path: 'content/**', edit: { allowedGroups: ['managers'] } },
      // Child folder overrides with editors
      { path: 'content/posts/**', edit: { allowedGroups: ['editors'] } },
      // Specific file overrides with specific user
      { path: 'content/posts/sensitive-post.mdx', edit: { allowedUsers: ['alice'] } },
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
