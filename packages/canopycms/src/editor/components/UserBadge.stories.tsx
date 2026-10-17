import type { Meta, StoryObj } from '@storybook/react'

import type { UserSearchResult } from '../../auth/types'
import type { CanopyUserId } from '../../types'
import { UserBadge } from './UserBadge'

const alice: UserSearchResult = {
  id: 'story-alice',
  name: 'Alice Johnson',
  email: 'alice@example.com',
}

const asUserId = (id: string): CanopyUserId => id as CanopyUserId

const meta: Meta<typeof UserBadge> = {
  title: 'Editor/UserBadge',
  component: UserBadge,
  args: {
    userId: asUserId(alice.id),
    getUserMetadata: async () => alice,
    showBadge: true,
    badgeVariant: 'light',
    color: 'gray',
  },
}

export default meta
type Story = StoryObj<typeof UserBadge>

/** A resolved name; the email is in a tooltip and read after the name by a screen reader. */
export const Named: Story = {}

/** The lookup answered with no such user: the badge says so and never shows the id. */
export const NameUnavailable: Story = {
  args: { userId: asUserId('story-unknown'), getUserMetadata: async () => null },
}

/** The directory has the person but no name for them: the badge says so, keeping the email. */
export const NamelessUser: Story = {
  args: {
    userId: asUserId('story-nameless'),
    getUserMetadata: async () => ({
      id: 'story-nameless',
      name: '',
      email: 'nameless@example.com',
    }),
  },
}

/** The lookup failed. */
export const CouldNotLoadName: Story = {
  args: {
    userId: asUserId('story-failed'),
    getUserMetadata: async () => {
      throw new Error('Network error')
    },
  },
}

/** An avatar shown alone: its name is hidden text, and its tooltip gives the name and email. */
export const AvatarOnly: Story = { args: { variant: 'avatar-only' } }

/** An avatar shown alone names itself for a screen reader. */
export const FallbackAvatarOnly: Story = {
  args: {
    userId: asUserId('story-unknown-avatar'),
    getUserMetadata: async () => null,
    variant: 'avatar-only',
  },
}

/** On an admin-only surface the id is in the tooltip and the screen-reader text, never on screen. */
export const NameUnavailableForAdmins: Story = {
  args: {
    userId: asUserId('story-unknown'),
    getUserMetadata: async () => null,
    revealIdOnFallback: true,
    onRemove: () => {},
    badgeVariant: 'filled',
    color: 'blue',
  },
}

/** A photo stand-in as a data URI, so the story needs no network. */
const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7c8db5"/><circle cx="32" cy="26" r="12" fill="#e8eaf2"/><rect x="12" y="42" width="40" height="22" rx="11" fill="#e8eaf2"/></svg>',
  )

/**
 * A photo avatar with a very long name in a narrow row: the avatar and name stay on one line and
 * the name ends in an ellipsis, with the full name in the tooltip.
 */
export const PhotoAvatarLongName: Story = {
  args: {
    userId: asUserId('story-long'),
    size: 'xs',
    getUserMetadata: async () => ({
      id: 'story-long',
      name: 'Alexandria Montgomery-Featherstonehaugh de la Cruz Fitzgerald',
      email: 'alexandria@example.com',
      avatarUrl: PHOTO,
    }),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 200, display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
}
