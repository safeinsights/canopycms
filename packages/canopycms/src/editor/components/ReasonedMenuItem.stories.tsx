import type { Meta, StoryObj } from '@storybook/react'
import { Button, Menu } from '@mantine/core'

import { DestructiveMenuItem } from './DestructiveMenuItem'
import { ReasonedMenuItem } from './ReasonedMenuItem'

const meta: Meta<typeof ReasonedMenuItem> = {
  title: 'Editor/ReasonedMenuItem',
  component: ReasonedMenuItem,
  decorators: [
    (Story) => (
      <div style={{ minHeight: 180 }}>
        <Menu opened withinPortal={false} width={260}>
          <Menu.Target>
            <Button variant="outline" color="gray">
              Hello
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Story />
          </Menu.Dropdown>
        </Menu>
      </div>
    ),
  ],
  args: { children: 'Reload entry', onClick: () => {} },
}

export default meta
type Story = StoryObj<typeof ReasonedMenuItem>

/** An item that can act now. */
export const Enabled: Story = {}

/** A blocked item stays in the menu and in keyboard order, with its reason and way forward beneath it. */
export const Blocked: Story = {
  args: { blockedReason: 'Open an entry first.' },
}

/** A delete or remove item, in the danger text colour over the red hover tint. */
export const Destructive: Story = {
  render: (args) => <DestructiveMenuItem {...args}>Delete entry</DestructiveMenuItem>,
}

/** A blocked destructive item reads dimmed, like any other blocked item. */
export const DestructiveBlocked: Story = {
  render: (args) => (
    <DestructiveMenuItem {...args} blockedReason="This branch is in review.">
      Delete entry
    </DestructiveMenuItem>
  ),
}
