import type { Meta, StoryObj } from '@storybook/react'
import { FieldCommentBadge } from './FieldCommentBadge'
import { Box } from '@mantine/core'

const meta: Meta<typeof FieldCommentBadge> = {
  title: 'Editor/Comments/FieldCommentBadge',
  component: FieldCommentBadge,
  decorators: [
    (Story) => (
      <Box pos="relative" w={300} h={100} bg="gray.1" p="md">
        <Story />
      </Box>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof FieldCommentBadge>

export const Unresolved: Story = {
  args: {
    count: 3,
    unresolvedCount: 3,
    resolved: false,
    onClick: () => console.log('Badge clicked'),
  },
}

export const PartiallyResolved: Story = {
  args: {
    count: 5,
    unresolvedCount: 2,
    resolved: false,
    onClick: () => console.log('Badge clicked'),
  },
}

export const AllResolved: Story = {
  args: {
    count: 3,
    unresolvedCount: 0,
    resolved: true,
    onClick: () => console.log('Badge clicked'),
  },
}

export const SingleUnresolved: Story = {
  args: {
    count: 1,
    unresolvedCount: 1,
    resolved: false,
    onClick: () => console.log('Badge clicked'),
  },
}

export const CustomColors: Story = {
  args: {
    count: 4,
    unresolvedCount: 4,
    resolved: false,
    unresolvedColor: 'blue',
    resolvedColor: 'green',
    onClick: () => console.log('Badge clicked'),
  },
}

export const NoComments: Story = {
  args: {
    count: 0,
    unresolvedCount: 0,
    resolved: true,
    onClick: () => console.log('Badge clicked'),
  },
}
