import { defineConfig, configDefaults } from 'vitest/config'

// vitest 4 removed `environmentMatchGlobs`; per-glob environments are now
// expressed as separate `projects`. The editor tree runs under jsdom (with the
// browser-mock setup file); everything else runs under node.
export default defineConfig({
  test: {
    globals: false,
    reporters: 'dot',
    env: {
      CANOPY_BOOTSTRAP_ADMIN_IDS: 'test-admin',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'src/editor/**'],
          // Git-heavy integration suites (git-manager, branch-workspace,
          // role-permissions) spawn real git subprocesses per test and can
          // exceed the 5s default on slower/loaded machines (e.g. local
          // macOS). CI (ubuntu) doesn't need this headroom but isn't hurt by
          // it either.
          testTimeout: 30000,
        },
      },
      {
        extends: true,
        test: {
          name: 'editor',
          environment: 'jsdom',
          include: ['src/editor/**/*.test.{ts,tsx}'],
          setupFiles: ['src/editor/test-setup.ts'],
        },
      },
    ],
  },
})
