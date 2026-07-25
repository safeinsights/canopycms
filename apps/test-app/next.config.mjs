import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // canopycms-auth-dev also ships raw TS via its exports map, so it must be
  // transpiled too — `next build` fails on it otherwise (next dev tolerates it).
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

export default nextConfig
