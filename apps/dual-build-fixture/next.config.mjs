import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withCanopy } from 'canopycms-next/config'

// Mirrors README.md's "Dual-Build Sites" convention exactly -- this app exists
// to CI-verify that convention, so it must build it the same way an adopter
// would, not a simplified stand-in.
//
// CANOPY_BUILD=static -> public static export (editor/API excluded)
// CANOPY_BUILD=cms    -> standalone Node.js server (editor/API included)
// unset (plain `next build`/`next dev`)   -> regular server build with editor included
const buildFlavor = process.env.CANOPY_BUILD

/** @type {import('next').NextConfig} */
const baseConfig = {
  ...(buildFlavor === 'static'
    ? { output: 'export' }
    : buildFlavor === 'cms'
      ? { output: 'standalone' }
      : {}),
  // Pin the tracing root to the monorepo root -- see apps/test-app/next.config.mjs
  // for why (git worktrees can have a second pnpm-lock.yaml, which makes Next
  // guess wrong and warn on every build otherwise).
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  eslint: { ignoreDuringBuilds: true },
}

export default withCanopy(baseConfig, { staticBuild: buildFlavor === 'static' })
