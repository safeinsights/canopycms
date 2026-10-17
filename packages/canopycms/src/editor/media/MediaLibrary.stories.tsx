import React, { useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import type { AssetRecord } from '../../api'
import { ApiClientProvider, type ApiClient } from '../context'
import { MediaLibrary } from './MediaLibrary'
import { MediaLibraryBody } from './MediaLibraryBody'
import { MEDIA_LIBRARY_PREFS_KEY } from './media-library-prefs'
import type { MediaDensity } from './media-library-view'

const meta: Meta<typeof MediaLibraryBody> = {
  title: 'Editor/MediaLibrary',
  component: MediaLibraryBody,
  parameters: { layout: 'padded' },
}

export default meta
type Story = StoryObj<typeof MediaLibraryBody>

const PAGE_SIZE = 40
const PALETTE = ['#4c6ef5', '#12b886', '#f08c00', '#e64980', '#7950f2', '#0c8599']

/** A flat-colour SVG as a `data:` URI, which the editor leaves untouched, so thumbnails render offline. */
function swatch(color: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${color}"/><text x="160" y="110" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function makeAsset(n: number): AssetRecord {
  const hash32 = n.toString(16).padStart(32, '0')
  const isPdf = n % 9 === 0
  const base = isPdf ? `brochure-${n}` : `photo-${String(n).padStart(3, '0')}`
  return {
    hash32,
    filename: `${base}.${isPdf ? 'pdf' : 'png'}`,
    slug: base,
    ext: isPdf ? 'pdf' : 'png',
    mime: isPdf ? 'application/pdf' : 'image/png',
    size: 4096 * n + 1500,
    ...(isPdf ? {} : { width: 1200, height: 800 }),
    kind: isPdf ? 'pdf' : 'raster',
    uploadedAt: new Date(Date.now() - n * 5 * 3600 * 1000).toISOString(),
    src: swatch(PALETTE[n % PALETTE.length]!, String(n)),
    // A few removed files, listed only once "Show removed files" is on.
    ...(n % 7 === 0 && { hidden: true }),
  }
}

const ALL_ASSETS = Array.from({ length: 120 }, (_, i) => makeAsset(i + 1))

interface FakeClientOptions {
  assets: AssetRecord[]
  /** The page (1-based) whose request never settles, so the library stays partly loaded. */
  holdPage?: number
  /** The page (1-based) whose request fails. */
  failPage?: number
}

/** An in-memory stand-in for the asset endpoints, paged 40 at a time like the real list. */
function createFakeClient({ assets, holdPage, failPage }: FakeClientOptions): ApiClient {
  const client = {
    assets: {
      list: async (params: Record<string, string>) => {
        const listed =
          params.includeHidden === 'true' ? assets : assets.filter((asset) => !asset.hidden)
        const pageNumber = params.cursor ? Number(params.cursor.replace('page-', '')) : 1
        if (pageNumber === holdPage) return new Promise<never>(() => {})
        if (pageNumber === failPage) {
          return { ok: false, status: 503, error: 'Service unavailable' }
        }
        const start = (pageNumber - 1) * PAGE_SIZE
        const end = start + PAGE_SIZE
        return {
          ok: true,
          status: 200,
          data: {
            assets: listed.slice(start, end),
            nextCursor: end < listed.length ? `page-${pageNumber + 1}` : undefined,
          },
        }
      },
      hide: async () => ({ ok: true, status: 200, data: { hidden: true } }),
      restore: async () => ({ ok: true, status: 200, data: { hidden: false } }),
    },
    user: {
      whoami: async () => ({
        ok: true,
        status: 200,
        data: { userId: 'story-admin', groups: ['Admins'] },
      }),
    },
  }
  return client as unknown as ApiClient
}

/** Provides the fake client and the stored layout the story wants, before the library mounts. */
const StoryFrame: React.FC<
  FakeClientOptions & { density?: MediaDensity; children: React.ReactNode }
> = ({ density = 'grid', children, assets, holdPage, failPage }) => {
  const client = useMemo(
    () => createFakeClient({ assets, holdPage, failPage }),
    [assets, holdPage, failPage],
  )
  useState(() => {
    try {
      window.localStorage.setItem(
        MEDIA_LIBRARY_PREFS_KEY,
        JSON.stringify({ sort: 'newest', density }),
      )
    } catch {
      // Storage is optional; the library falls back to its defaults.
    }
  })
  return (
    <ApiClientProvider client={client}>
      <div style={{ width: '100%', maxWidth: 660, height: 720 }}>{children}</div>
    </ApiClientProvider>
  )
}

export const ManageGrid: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS}>
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const Compact: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} density="compact">
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const List: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} density="list">
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const Picker: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS}>
      <MediaLibraryBody
        opened
        mode="picker"
        onSelect={(asset) => alert(`Select ${asset.filename}`)}
      />
    </StoryFrame>
  ),
}

/** The second page never arrives: type a search to see the "Searching…" notice in place of an empty state. */
export const Searching: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} holdPage={2}>
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const Empty: Story = {
  render: () => (
    <StoryFrame assets={[]}>
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const ManageDrawer: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS}>
      <MediaLibrary opened onClose={() => {}} mode="manage" />
    </StoryFrame>
  ),
}

/** Page 1 never arrives: the skeleton in the shape of the grid. */
export const Loading: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} holdPage={1}>
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const ErrorFirstPage: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} failPage={1}>
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

/** Page 2 fails: page 1 stays, and Retry resumes from page 2. */
export const ErrorLaterPage: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} failPage={2}>
      <MediaLibraryBody opened mode="manage" />
    </StoryFrame>
  ),
}

export const PickerList: Story = {
  render: () => (
    <StoryFrame assets={ALL_ASSETS} density="list">
      <MediaLibraryBody
        opened
        mode="picker"
        onSelect={(asset) => alert(`Select ${asset.filename}`)}
      />
    </StoryFrame>
  ),
}
