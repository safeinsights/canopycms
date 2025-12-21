import type { Meta, StoryObj } from '@storybook/react'
import { GroupManager } from './GroupManager'
import type { InternalGroup } from '../groups-file'
import type { ExternalGroup } from '../api/groups'
import type { UserSearchResult } from '../auth/types'

const meta: Meta<typeof GroupManager> = {
  title: 'Editor/GroupManager',
  component: GroupManager,
}

export default meta
type Story = StoryObj<typeof GroupManager>

// Mock external groups (Clerk organizations)
const mockExternalGroups: ExternalGroup[] = [
  {
    id: 'org_clerk_123',
    name: 'Acme Corporation',
  },
  {
    id: 'org_clerk_456',
    name: 'Partner Organization',
  },
  {
    id: 'org_clerk_789',
    name: 'Enterprise Partners LLC',
  },
]

// Mock internal groups
const mockInternalGroups: InternalGroup[] = [
  {
    id: 'editors',
    name: 'Content Editors',
    description: 'Team members who can edit blog posts and pages',
    members: ['user-1', 'user-2', 'user-3'],
  },
  {
    id: 'marketing',
    name: 'Marketing Team',
    description: 'Marketing and communications staff',
    members: ['user-4', 'user-5'],
  },
  {
    id: 'customer-support',
    name: 'Customer Support',
    members: ['user-6', 'user-7', 'user-8', 'user-9'],
  },
]

// Mock user search results
const mockUserSearchResults: UserSearchResult[] = [
  { id: 'user-1', name: 'Alice Johnson', email: 'alice@example.com' },
  { id: 'user-2', name: 'Bob Smith', email: 'bob@example.com' },
  { id: 'user-3', name: 'Charlie Brown', email: 'charlie@example.com' },
  { id: 'user-4', name: 'Diana Prince', email: 'diana@example.com' },
  { id: 'user-5', name: 'Eve Martinez', email: 'eve@example.com' },
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

const mockSearchExternalGroups = async (query: string): Promise<ExternalGroup[]> => {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Filter mock results
  const filtered = mockExternalGroups.filter((g) =>
    g.name.toLowerCase().includes(query.toLowerCase()) || g.id.toLowerCase().includes(query.toLowerCase())
  )

  return filtered
}

const mockSave = async (groups: InternalGroup[]): Promise<void> => {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 1000))
  console.log('Saving groups:', groups)
}

export const Default: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const InternalGroupsOnly: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const Empty: Story = {
  args: {
    internalGroups: [],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const ReadOnly: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: false,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const Loading: Story = {
  args: {
    internalGroups: [],
    loading: true,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const SaveError: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      throw new Error('Failed to save: Network error')
    },
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const UserSearchError: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      throw new Error('User search failed')
    },
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const ExternalSearchError: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      throw new Error('External group search failed')
    },
    onClose: () => console.log('Close clicked'),
  },
}

export const NoSearchUsers: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: mockSave,
    // No onSearchUsers - auth plugin not configured
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const NoExternalSearch: Story = {
  args: {
    internalGroups: mockInternalGroups,
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    // No onSearchExternalGroups - not configured
    onClose: () => console.log('Close clicked'),
  },
}

export const ManyMembers: Story = {
  args: {
    internalGroups: [
      {
        id: 'large-team',
        name: 'Large Team',
        description: 'A team with many members',
        members: [
          'user-1',
          'user-2',
          'user-3',
          'user-4',
          'user-5',
          'user-6',
          'user-7',
          'user-8',
          'user-9',
          'user-10',
          'user-11',
          'user-12',
          'user-13',
          'user-14',
          'user-15',
        ],
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const LongNames: Story = {
  args: {
    internalGroups: [
      {
        id: 'very-long-group-id-that-might-cause-layout-issues',
        name: 'Very Long Group Name That Might Cause Layout Issues In The UI',
        description:
          'This is a very long description that goes on and on and might cause some layout issues if not handled properly in the UI component design',
        members: [
          'user-with-an-extremely-long-email-address-that-might-cause-layout-issues@verylongdomain.example.com',
        ],
      },
      {
        id: 'normal',
        name: 'Normal Group',
        members: ['user-1'],
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}

export const MixedScenario: Story = {
  args: {
    internalGroups: [
      {
        id: 'editors',
        name: 'Content Editors',
        description: 'Team members who can edit blog posts and pages',
        members: ['alice@example.com', 'bob@example.com'],
      },
      {
        id: 'empty-group',
        name: 'Empty Group',
        description: 'A group with no members yet',
        members: [],
      },
      {
        id: 'no-description',
        name: 'Group Without Description',
        members: ['charlie@example.com'],
      },
    ],
    canEdit: true,
    onSave: mockSave,
    onSearchUsers: mockSearchUsers,
    onSearchExternalGroups: mockSearchExternalGroups,
    onClose: () => console.log('Close clicked'),
  },
}
