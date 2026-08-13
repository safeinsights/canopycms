import { defineConfig, configDefaults } from 'vitest/config'

// Dev-mode branch clones (created lazily by the CMS build's live-server test)
// copy this entire directory -- including dual-build.test.ts itself -- into
// .canopy-dev/content-branches/<branch>/. Without excluding that path,
// Vitest's default recursive discovery picks up the copy as a second test
// file (pointed at a workspace with no node_modules of its own), producing
// confusing spawn ENOENT failures unrelated to the actual build/output
// assertions below.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.canopy-dev/**'],
  },
})
