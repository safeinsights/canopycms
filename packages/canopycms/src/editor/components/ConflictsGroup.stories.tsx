import type { Meta, StoryObj } from '@storybook/react'
import React, { useState } from 'react'

import type { EntryConflictChoice, EntryConflictData } from '../../api/merge-conflicts'
import { buildEntryConflicts, type FieldConflict } from '../conflict-cards'
import type { EntryChoices, FieldChoice } from '../conflict-choices'
import { ConflictsGroup, type ConflictsGroupProps } from './ConflictsGroup'
import {
  BASE_SHA,
  conflictFields,
  conflictRecordFields,
  entryConflictData,
  keylessConflictData,
  fieldsConflictData,
  savedValue,
} from './__test__/conflict-fixtures'

type FieldName = keyof typeof conflictRecordFields
type FormValue = Record<string, unknown>

interface HarnessProps {
  /** The entry's conflict record; fields from `only` when it is not given. */
  data?: EntryConflictData
  only?: FieldName[]
  /** The form's starting value; the merge's result when not given. */
  value?: FormValue
  /** Omit the form, as for an entry that is not the open one. */
  noForm?: boolean
  adminBaseBranch?: string
  lockedReason?: string
  noEditReason?: string
  unsavedEdits?: boolean
  /** The branch deleted the entry since its conflicts were found. */
  entryDeleted?: boolean
}

/** The group over a form value and choices it changes, so a choice shows as chosen. */
const Harness: React.FC<HarnessProps> = ({
  data: given,
  only,
  value: initial,
  noForm,
  ...rest
}) => {
  const data = React.useMemo(() => given ?? fieldsConflictData(only), [given, only])
  const conflicts = React.useMemo(() => buildEntryConflicts(data, conflictFields, 'body'), [data])
  const [value, setValue] = useState<FormValue>(initial ?? savedValue)
  const [choices, setChoices] = useState<EntryChoices>({})
  const [last, setLast] = useState<EntryConflictChoice>()
  const props: ConflictsGroupProps = {
    data,
    conflicts,
    choices,
    form: noForm
      ? undefined
      : { value, saved: savedValue, update: (update) => setValue(update), bodyField: 'body' },
    onChoose: (field: FieldConflict, choice: FieldChoice | undefined) =>
      setChoices((prev) => {
        const { [field.key]: _gone, ...others } = prev
        return choice ? { ...others, [field.key]: { mergeSha: field.mergeSha, choice } } : others
      }),
    onEdit: () => {},
    onResolveEntry: async (choice) => {
      setLast(choice)
      return undefined
    },
    ...rest,
  }
  return (
    <div style={{ maxWidth: 960, padding: 16 }}>
      <ConflictsGroup {...props} />
      {last && <p>Entry choice made: {last}</p>}
    </div>
  )
}

const meta: Meta<typeof Harness> = {
  title: 'Editor/ConflictsGroup',
  component: Harness,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof Harness>

/** A field both sides changed: the latest version, yours, or Edit. */
export const FieldChanged: Story = { args: { only: ['summary'] } }

/** A field inside an object, named by its path. */
export const NestedField: Story = { args: { only: ['heading'] } }

/** The latest version removed a field you changed: "Remove it" or "Keep it". */
export const RemovedOnLatest: Story = { args: { only: ['readTime'] } }

/** You removed a field the latest version changed. */
export const RemovedByYou: Story = { args: { only: ['tagline'] } }

/** A whole list item the latest version removed; there is no Edit. */
export const ListItem: Story = { args: { only: ['step'] } }

/** A field of an item the latest version keyed apart, in a list it left keyless: all three show. */
export const KeylessListItem: Story = { args: { data: keylessConflictData() } }

/** A value shown whole, here an image. */
export const WholeValueImage: Story = { args: { only: ['cover'] } }

/** Long text both sides changed, one card per region, each with "Use both". */
export const BodyRegions: Story = { args: { only: ['body'] } }

/** The entry moved to different URLs: the branch's URL stands. */
export const Location: Story = { args: { only: ['location'] } }

export const EntryDeletedOnLatest: Story = {
  args: { data: entryConflictData('deleted-on-base') },
}

export const EntryDeletedByYou: Story = {
  args: { data: entryConflictData('deleted-on-branch') },
}

export const EntryUnreadable: Story = {
  args: { data: entryConflictData('unreadable') },
}

/** Field conflicts on an entry the branch deleted since: no form to choose in, so one card keeps it deleted. */
export const DeletedEntryWithFields: Story = {
  args: { only: ['summary', 'readTime'], noForm: true, entryDeleted: true },
}

/** Every kind of field conflict at once. */
export const AllKinds: Story = {}

export const AllKindsDark: Story = { globals: { colorScheme: 'dark' } }

/** An admin's Tooltip on "Latest version" names the branch it comes from. */
export const AdminView: Story = { args: { adminBaseBranch: 'main' } }

/** The latest version couldn't be read: its card says so, and the choices that take it wait. */
export const LatestUnreadable: Story = {
  args: {
    data: (() => {
      const data = fieldsConflictData(['summary', 'readTime', 'tagline'])
      data.versions[BASE_SHA] = { unavailable: 'too-large' }
      return data
    })(),
  },
}

/** A locked branch: the choices stay, disabled, with the lock's reason. */
export const Locked: Story = {
  args: {
    only: ['summary', 'readTime'],
    lockedReason: 'This branch is in review. Withdraw it to make changes.',
  },
}

/** The form was edited since the merge: "Mark resolved" in place of keeping yours. */
export const EditedInForm: Story = {
  args: { only: ['summary'], value: { ...savedValue, summary: 'My own wording.' } },
}

/** Another entry's conflicts: shown, with a line saying to open it. */
export const ReadOnlyOtherEntry: Story = { args: { only: ['summary', 'readTime'], noForm: true } }

/** An entry with unsaved edits holds the choices that would replace them. */
export const EntryUnsavedEdits: Story = {
  args: { data: entryConflictData('deleted-on-base'), unsavedEdits: true },
}

/** No edit access: the cards, and one line saying why. */
export const NoEditAccess: Story = {
  args: {
    only: ['summary'],
    noEditReason: "You don't have edit access to this entry. Ask a CanopyCMS admin to grant it.",
  },
}

/** At phone width each card's three versions stack. */
export const Narrow: Story = {
  parameters: {
    viewport: {
      viewports: { phone: { name: 'Phone', styles: { width: '390px', height: '844px' } } },
      defaultViewport: 'phone',
    },
  },
}
