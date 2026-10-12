import { useEffect } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Button, Group, Text } from '@mantine/core'
import { modals } from '@mantine/modals'

import { openConfirm } from './confirm-modal'

const OpensConfirm = ({ confirm, color }: { confirm: string; color: 'red' | 'orange' }) => {
  useEffect(() => {
    const id = openConfirm({
      title: color === 'red' ? 'Delete entry' : 'Withdraw from review',
      children: (
        <Text size="sm">The confirm button is filled and takes the theme&apos;s shade.</Text>
      ),
      labels: { confirm, cancel: 'Cancel' },
      confirmProps: { color },
    })
    return () => modals.close(id)
  }, [confirm, color])
  return null
}

const meta: Meta = {
  title: 'Editor/Confirm modal',
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

/** A destructive confirm: filled `red.8` under white text. */
export const FilledRedConfirm: Story = {
  render: () => <OpensConfirm confirm="Delete entry" color="red" />,
}

/** A reversible workflow confirm: filled `orange.6` under black text. */
export const FilledOrangeConfirm: Story = {
  render: () => <OpensConfirm confirm="Withdraw from review" color="orange" />,
}

/** The same colours as buttons outside a modal, beside the variants the theme leaves alone. */
export const FilledAndLightButtons: Story = {
  render: () => (
    <Group p="md">
      <Button color="red">Delete entry</Button>
      <Button color="orange">Withdraw from review</Button>
      <Button color="red" variant="light">
        Delete branch
      </Button>
      <Button color="orange" variant="light">
        Withdraw
      </Button>
    </Group>
  ),
}
