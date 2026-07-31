import { defineCanopyConfig } from 'canopycms'

// Same CANOPY_BUILD env var next.config.mjs reads -- see README.md's
// "Dual-Build Sites" section for why deployedAs and pageExtensions are
// driven off the same flavor flag.
const isStaticBuild = process.env.CANOPY_BUILD === 'static'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
  // Anonymous reads must succeed on the CMS/server build so this fixture's
  // dual-build.test.ts can hit `/` on a running `next start` and see the
  // same content the static export baked in at build time -- see README.md's
  // "Public read on server deployments" section.
  defaultPathAccess: { read: 'allow' },
  mode: 'dev',
  sourceRoot: 'apps/dual-build-fixture',
  deployedAs: isStaticBuild ? 'static' : 'server',
  gitBotAuthorName: 'CanopyCMS Dual-Build Fixture Bot',
  gitBotAuthorEmail: 'dual-build-fixture@example.com',
  editor: {
    title: 'Dual-Build Fixture Editor',
    subtitle: 'CI safety net for the static/cms build split',
    theme: {
      colors: {
        brand: '#4f46e5',
        accent: '#0ea5e9',
        neutral: '#0f172a',
      },
    },
  },
})
