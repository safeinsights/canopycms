import type { Meta, StoryObj } from '@storybook/react'

import type { UserSearchResult } from '../../auth/types'
import { BranchAccessList } from './BranchAccessList'

const names: Record<string, string> = { u1: 'Ada Lovelace', u2: 'Grace Hopper' }
const lookup = async (id: string): Promise<UserSearchResult | null> =>
  names[id] ? { id, name: names[id], email: '' } : null

const meta: Meta<typeof BranchAccessList> = {
  title: 'Editor/BranchAccessList',
  component: BranchAccessList,
  args: { getUserMetadata: lookup },
}

export default meta
type Story = StoryObj<typeof BranchAccessList>

export const Named: Story = { args: { users: ['u1', 'u2'], groups: ['team-a'] } }

/** Some names resolve; the rest are counted. */
export const NamedAndOthers: Story = {
  args: { users: ['u1', 'u9', 'u8'], groups: ['team-a'] },
}

/** A viewer who can name no one sees only the count. */
export const CountedOnly: Story = { args: { users: ['u7', 'u8', 'u9'] } }

export const Loading: Story = {
  args: { users: ['u1'], getUserMetadata: () => new Promise(() => {}) },
}
