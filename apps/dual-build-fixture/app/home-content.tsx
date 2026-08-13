import { read } from './lib/canopy'

interface HomeData {
  message: string
}

// Shared implementation for the `/` route, per README.md's "Dual-Build
// Sites" convention: a plain (non-route) module, re-exported by both
// page.static.tsx and page.server.tsx so there is exactly one implementation
// to keep in sync between the two builds. There is no plain `page.tsx` --
// see the note at the end of that README section for why one would collide.
export default async function HomeContent() {
  const { data } = await read<HomeData>({ entryPath: 'content/home' })

  return (
    <main>
      <h1>Dual-Build Fixture</h1>
      {/* dual-build.test.ts greps both builds' output for this content --
          it is how the fixture proves both shapes read the same source. */}
      <p data-testid="content-marker">{data.message}</p>
    </main>
  )
}
