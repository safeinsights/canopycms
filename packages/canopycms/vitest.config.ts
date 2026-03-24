import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['src/editor/**', 'jsdom']],
    setupFiles: ['src/editor/test-setup.ts'],
    reporters: 'dot',
    env: {
      CANOPY_BOOTSTRAP_ADMIN_IDS: 'test-admin',
    },
  },
})
