import type { Meta, StoryObj } from '@storybook/react'
import { useMemo, useState } from 'react'

import { ApiClientProvider, type ApiClient } from '../context'
import { ReferenceListField } from './ReferenceListField'
import type { ReferenceOption } from './use-reference-options'

const meta: Meta<typeof ReferenceListField> = {
  title: 'Editor/Fields/Reference list',
  component: ReferenceListField,
}

export default meta
type Story = StoryObj<typeof ReferenceListField>

const POSTS: ReferenceOption[] = [
  { value: 'post-spring', label: 'Spring launch' },
  { value: 'post-summer', label: 'Summer recap' },
  { value: 'post-autumn', label: 'Autumn preview' },
  { value: 'post-winter', label: 'Winter notes' },
  { value: 'post-review', label: 'Year in review' },
  { value: 'post-guide', label: 'A field guide to the new release' },
]

const HIDE = { fieldLabel: 'Hide from search engines' }
/** Two posts whose own forms hide them from search, as a draft about to go public might be. */
const WITH_HIDDEN: ReferenceOption[] = POSTS.map((option) =>
  option.value === 'post-summer' || option.value === 'post-guide'
    ? { ...option, noindex: HIDE }
    : option,
)

const List: React.FC<{
  initial: unknown[]
  maxItems?: number
  readOnly?: boolean
  options?: ReferenceOption[]
  /** Loads options through the API (which a story can hold) instead of taking them as given. */
  fetched?: boolean
}> = ({ initial, maxItems, readOnly = false, options = POSTS, fetched = false }) => {
  const [value, setValue] = useState<unknown[]>(initial)
  return (
    <div style={{ maxWidth: 560 }}>
      <ReferenceListField
        id="featured"
        label="Teaser strip"
        description="Posts shown in the strip, in this order."
        options={fetched ? undefined : options}
        collections={fetched ? ['posts'] : undefined}
        value={value}
        onChange={setValue}
        path={['featured']}
        canopyPath="featured"
        readOnly={readOnly}
        resetKey="story"
        maxItems={maxItems}
      />
    </div>
  )
}

/** Options that never arrive, so the loading state stays on screen. */
const HeldOptions: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const client = useMemo(
    () =>
      ({
        content: { getReferenceOptions: () => new Promise(() => {}) },
      }) as unknown as ApiClient,
    [],
  )
  return <ApiClientProvider client={client}>{children}</ApiClientProvider>
}

export const Empty: Story = { render: () => <List initial={[]} /> }

/** Three picks, all open; Add leaves out what is already picked. */
export const Picked: Story = {
  render: () => <List initial={['post-autumn', 'post-spring', 'post-winter']} />,
}

/** At the cap, Add gives way to a note on swapping or removing. */
export const AtTheCap: Story = {
  render: () => <List initial={['post-autumn', 'post-spring', 'post-winter']} maxItems={3} />,
}

/** Over the cap, as after two branches each added a pick; saving shows the inline error. */
export const OverTheCap: Story = {
  render: () => (
    <List initial={['post-autumn', 'post-spring', 'post-winter', 'post-summer']} maxItems={3} />
  ),
}

/** Picks the options leave out keep their place, labelled for what they are. */
export const UnavailablePicks: Story = {
  render: () => (
    <List
      initial={[
        'post-spring',
        { id: 'post-gone', unavailable: true, reason: 'missing' },
        { id: 'post-memo', unavailable: true, reason: 'restricted', title: 'Internal memo' },
      ]}
    />
  ),
}

/** Row titles and Add hold placeholders until the options arrive. */
export const Loading: Story = {
  render: () => (
    <HeldOptions>
      <List initial={['post-autumn', 'post-spring']} fetched />
    </HeldOptions>
  ),
}

/** A hidden pick carries a badge, and one note above the list says what that means. */
export const HiddenFromSearch: Story = {
  render: () => (
    <List initial={['post-spring', 'post-summer', 'post-winter']} options={WITH_HIDDEN} />
  ),
}

export const ReadOnly: Story = {
  render: () => <List initial={['post-autumn', 'post-spring', 'post-winter']} readOnly />,
}
