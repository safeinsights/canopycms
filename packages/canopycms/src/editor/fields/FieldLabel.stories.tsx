import type { Meta, StoryObj } from '@storybook/react'
import { ActionIcon, Box, Button } from '@mantine/core'
import { IconMessage } from '@tabler/icons-react'

import { FieldLabel } from './FieldLabel'

const meta: Meta<typeof FieldLabel> = {
  title: 'Editor/Fields/FieldLabel',
  component: FieldLabel,
}

export default meta

type Story = StoryObj<typeof FieldLabel>

const CommentPlaceholder = (
  <ActionIcon variant="subtle" color="gray" aria-label="Comments">
    <IconMessage size={14} />
  </ActionIcon>
)

export const Basic: Story = {
  args: { label: 'Headline' },
}

export const Required: Story = {
  args: { label: 'Headline', required: true },
}

export const WithDescription: Story = {
  args: {
    label: 'Headline',
    description: 'Shown at the top of the page and in search results.',
    descriptionBaseId: 'story-description',
  },
}

export const WithActions: Story = {
  args: {
    label: 'Team members',
    actions: <Button variant="light">Add item</Button>,
  },
}

export const WithCommentControl: Story = {
  args: { label: 'Headline', commentControl: CommentPlaceholder },
}

export const AllSlots: Story = {
  args: {
    label: 'Team members',
    required: true,
    description: 'People shown on the About page.',
    descriptionBaseId: 'story-all-slots',
    commentControl: CommentPlaceholder,
    actions: <Button variant="light">Add item</Button>,
  },
}

export const LongLabelTruncation: Story = {
  args: {
    label: 'A very long label that keeps going well past the width of its container',
    commentControl: CommentPlaceholder,
    actions: <Button variant="light">Add item</Button>,
  },
  render: (args) => (
    <Box w={320}>
      <FieldLabel {...args} />
    </Box>
  ),
}
