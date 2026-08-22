import { defineConfig, configDefaults } from 'vitest/config'

// Dev-mode branch clones (created lazily by build-verify.test.ts's own `next
// build`) copy this entire directory -- including build-verify.test.ts
// itself -- into .canopy-dev/content-branches/<branch>/. Without excluding
// that path, Vitest's default recursive discovery picks up the copy as a
// second test file (pointed at a workspace with no node_modules of its own),
// producing confusing spawn ENOENT failures unrelated to the actual
// build/output assertions below. Same fix as apps/dual-build-fixture's
// vitest.config.ts, which hit the identical issue first.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.canopy-dev/**'],
  },
})
