import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Button } from '@mantine/core'

import { QuickOpenPalette, type QuickOpenEntry } from './QuickOpenPalette'

const meta: Meta<typeof QuickOpenPalette> = {
  title: 'Editor/QuickOpenPalette',
  component: QuickOpenPalette,
}

export default meta
type Story = StoryObj<typeof QuickOpenPalette>

const TYPES: Record<string, string> = { guides: 'Guide', news: 'News item', pages: 'Page' }

const ENTRIES: QuickOpenEntry[] = [
  ['guides', 'getting-started', 'Getting started'],
  ['guides', 'data-access', 'Requesting access to data'],
  ['guides', 'privacy', 'Privacy and security'],
  ['guides', 'enclave', 'Working inside a secure enclave'],
  ['news', 'launch', 'Launch announcement'],
  ['news', 'new-members', 'New members join the network'],
  ['news', 'webinar', 'Autumn webinar series'],
  ['news', 'funding', 'New funding round'],
  ['pages', 'home', 'Home'],
  ['pages', 'about', 'About us'],
  ['pages', 'contact', 'Contact'],
  ['pages', 'faq', 'Frequently asked questions'],
].map(
  ([collection, slug, label]): QuickOpenEntry => ({
    path: `content/${collection}/${slug}`,
    label,
    slug,
    collectionPath: `content/${collection}`,
    collectionName: collection,
    typeLabel: TYPES[collection],
    route: slug === 'home' ? '/' : `/${collection}/${slug}/`,
  }),
)

// A singleton is named by its type, so it shows no type line, and with no page, no route.
ENTRIES.push({
  path: 'content/pages/settings',
  label: 'Site settings',
  slug: 'settings',
  collectionPath: 'content/pages',
  collectionName: 'pages',
})

const labels: Record<string, string> = {
  'content/guides': 'Guides',
  'content/news': 'News',
  'content/pages': 'Pages',
}

function Palette() {
  const [opened, setOpened] = useState(true)
  const [selected, setSelected] = useState<string>()
  return (
    <>
      <Button onClick={() => setOpened(true)}>Open palette (or press Ctrl+P)</Button>
      {selected && <p>Opened {selected}</p>}
      <QuickOpenPalette
        opened={opened}
        onOpen={() => setOpened(true)}
        onClose={() => setOpened(false)}
        entries={ENTRIES}
        collectionLabel={(path) => labels[path]}
        onSelect={setSelected}
      />
    </>
  )
}

export const Opened: Story = {
  render: () => <Palette />,
}
