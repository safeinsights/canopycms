import { defineConfig, configDefaults } from 'vitest/config'
import { ownedTmpdirSetup, quietTestOutput } from '../../vitest.shared'

// vitest 4 removed `environmentMatchGlobs`; per-glob environments are now
// expressed as separate `projects`. The editor tree runs under jsdom (with the
// browser-mock setup file); everything else runs under node.
export default defineConfig({
  test: {
    globals: false,
    // `dot` reporter + the CI `onConsoleLog` guard, shared with every package.
    // Swallow and assert expected output with mockConsole() (src/test-utils/console-spy.ts).
    ...quietTestOutput,
    // Owns os.tmpdir() for the run, so no test can strand a temp directory.
    // src/test-utils/owned-tmpdir.test.ts fails if this is dropped.
    globalSetup: [ownedTmpdirSetup],
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
          setupFiles: ['src/test-utils/quiet-provision-log.ts'],
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
          // The GitHub gateway's suites, and the worker suites that reach it, again with the
          // worker reaching the gateway through its socket transport (test-utils/worker-gateway.ts,
          // GATEWAY_TRANSPORT): one set of assertions for both.
          name: 'worker-http',
          environment: 'node',
          include: [
            'src/worker/github-gateway*.test.ts',
            'src/worker/cms-worker*.test.ts',
            'src/branch-provisioning.test.ts',
          ],
          env: { CANOPY_TEST_GATEWAY_TRANSPORT: 'http' },
          setupFiles: [
            'src/test-utils/quiet-provision-log.ts',
            'src/test-utils/gateway-transport-setup.ts',
          ],
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
