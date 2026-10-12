import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { ObjectFieldConfig } from '../../config'
import { ObjectListField } from './ObjectListField'
import { useListItemKeys } from './list-item-keys'
import { TextField } from './TextField'

const meta: Meta<typeof ObjectListField> = {
  title: 'Editor/Fields/Object list',
  component: ObjectListField,
}

export default meta
type Story = StoryObj<typeof ObjectListField>

const field: ObjectFieldConfig = {
  name: 'team',
  type: 'object',
  label: 'Team',
  list: true,
  itemTitleField: 'name',
  itemLabel: 'team member',
  fields: [
    { name: 'name', type: 'string', label: 'Name' },
    { name: 'role', type: 'string', label: 'Role' },
  ],
}

const people = [
  { name: 'Ada', role: 'Engineering lead' },
  { name: 'Grace', role: 'Compiler wrangler' },
  { name: 'Katherine', role: 'Trajectory analysis' },
  { name: 'Margaret', role: 'Flight software' },
  { name: 'Radia', role: 'Networking' },
]

const List: React.FC<{ initial: Record<string, unknown>[]; readOnly?: boolean }> = ({
  initial,
  readOnly = false,
}) => {
  const [items, setItems] = useState(initial)
  const itemKeys = useListItemKeys()(items, 'team')
  return (
    <ObjectListField
      id="team"
      label={field.label ?? field.name}
      field={field}
      items={items}
      itemKeys={itemKeys}
      onChange={setItems}
      path={['team']}
      canopyPath="team"
      readOnly={readOnly}
      resetKey="story"
      renderField={(child, value, update) => (
        <TextField
          label={child.label ?? child.name}
          value={typeof value === 'string' ? value : ''}
          onChange={update}
          readOnly={readOnly}
        />
      )}
    />
  )
}

/** Three or fewer items all start open; the add button names the item ("Add team member"). */
export const Default: Story = { render: () => <List initial={people.slice(0, 2)} /> }

/** More than three: only the first starts open. */
export const LongList: Story = { render: () => <List initial={people} /> }

export const ReadOnly: Story = { render: () => <List initial={people} readOnly /> }

export const Empty: Story = { render: () => <List initial={[]} /> }
