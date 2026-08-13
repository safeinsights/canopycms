import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withCanopy } from 'canopycms-next/config'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // canopycms-auth-dev also ships raw TS via its exports map, so it must be
  // transpiled too — `next build` fails on it otherwise (next dev tolerates it).
  // withCanopy() also auto-detects these; the explicit list is kept because it
  // documents the intent and withCanopy dedupes.
  transpilePackages: ['canopycms', 'canopycms-next', 'canopycms-auth-dev'],
  // Pin the tracing root to the monorepo root. Without it Next guesses from
  // lockfile locations and warns on every dev/build/start ("inferred your
  // workspace root"), especially in git worktrees where a second
  // pnpm-lock.yaml exists — that warning was e2e log noise.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  // This test app has no Next ESLint setup (the repo lints with its own
  // config); skip the build-time lint pass and its "plugin not detected" note.
  eslint: { ignoreDuringBuilds: true },
}

// The test app must be wrapped exactly like a real adopter (see
// apps/example1/next.config.mjs and README's integration steps). Without this
// the `/assets/:path*` -> `/api/canopycms/assets/raw/assets/:path*` rewrite is
// never registered, so every public asset URL the editor renders — MediaLibrary
// thumbnails, ImageField previews, and every `/assets/t/{directives}/...`
// transform output — 404s. That was invisible until the media e2e specs
// existed, because nothing else in the suite requested an asset URL.
export default withCanopy(nextConfig)
