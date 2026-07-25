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
    // Keep the reporter to "all dots": a test that writes to the console is
    // almost always leaking an expected log/warn/error that should instead be
    // swallowed (and asserted) with mockConsole() from
    // src/test-utils/console-spy.ts. In CI we fail hard so noise can't creep
    // back in; locally we let the message through so ad-hoc console.log
    // debugging still works. Output wrapped in mockConsole() never reaches
    // here — it replaces the console method before Vitest's interceptor runs.
    onConsoleLog(log, type) {
      if (process.env.CI) {
        throw new Error(
          `A test wrote to console.${type}, which clutters the test reporter:\n\n` +
            `${log}\n\n` +
            `Wrap the expected output with mockConsole() from ` +
            `src/test-utils/console-spy.ts (it swallows the message and lets you ` +
            `assert it via toHaveLogged/toHaveWarned/toHaveErrored), or remove the ` +
            `stray log.`,
        )
      }
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
