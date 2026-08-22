import React from 'react'
import { notFound } from 'next/navigation'
import type { HomeContent } from './schemas'
import HomeView from './components/HomeView'
import { readByUrlPath } from './lib/canopy'

// The home entry is a ROOT INDEX ENTRY: it lives at `content/home.index.<id>.json`, so its slug is
// `index` and CanopyCMS collapses that onto the collection's own path — for the root collection,
// `/`. That is the whole reason this page resolves by URL rather than by entry path.
//
// It used to read `{ entryPath: 'content/home' }`, addressing the entry by its ENTRY TYPE
// ('content' + type name 'home') instead of by URL. That works, but it means the entry's real
// `urlPath` is `/home` while this route serves it at `/` — two different answers to "where does
// home live", which app/sitemap.ts then had to paper over with an exclusion plus a hand-written
// extra URL. Modelling it as an index entry makes the structural URL and the served URL the same
// string, and both of those workarounds disappear.
//
// Prefer this shape for any singleton you serve at a collection's own path.
const Page = async () => {
  // Phase-selecting read: build context at build, branch-aware runtime context at request time.
  const result = await readByUrlPath<HomeContent>('/')

  if (!result) return notFound()

  return <HomeView data={result.data} />
}

export default Page
