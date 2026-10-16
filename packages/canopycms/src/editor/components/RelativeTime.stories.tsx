import type { Meta, StoryObj } from '@storybook/react'

import { RelativeTime } from './RelativeTime'

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

const meta: Meta<typeof RelativeTime> = {
  title: 'Editor/RelativeTime',
  component: RelativeTime,
  args: { iso: hoursAgo(3), size: 'xs', c: 'dimmed' },
}

export default meta
type Story = StoryObj<typeof RelativeTime>

/** The relative label shows; the absolute date is in a tooltip and read after the label. */
export const Recent: Story = {}

export const WithPrefix: Story = { args: { prefix: 'Updated ', iso: hoursAgo(24 * 9) } }

/** An unparseable value shows as it is, with no tooltip. */
export const Unparseable: Story = { args: { iso: 'not-a-date' } }
