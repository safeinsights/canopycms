import js from '@eslint/js'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import securityPlugin from 'eslint-plugin-security'
import typescriptEslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.next/**',
      '.turbo/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      // Next.js-generated type shim (regenerated on every build; not meant to be linted)
      '**/next-env.d.ts',
      'packages/canopycms/src/api/client.ts',
      'packages/canopycms/src/api/__test__/mock-client.ts',
    ],
  },
  // Base recommended rules
  js.configs.recommended,
  // TypeScript recommended rules
  ...typescriptEslint.configs.recommended,
  // Security rules (ReDoS, injection, eval, etc.)
  {
    ...securityPlugin.configs.recommended,
    rules: {
      ...securityPlugin.configs.recommended.rules,
      // A CMS reads/writes files by design — non-literal fs paths are expected
      'security/detect-non-literal-fs-filename': 'off',
      // Object bracket access with variables is normal TS — too noisy
      'security/detect-object-injection': 'off',
    },
  },
  // React configuration (for packages and apps with JSX)
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/prop-types': 'off',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  // Project-wide rules (strict by default)
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_+$',
          argsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      semi: ['error', 'never'],
    },
  },

  // --- File-based overrides ---

  // CLI scripts produce user-facing output via console
  {
    files: ['**/cli/**'],
    rules: {
      'no-console': 'off',
    },
  },
  // Worker daemon: bare console is BANNED here, which is the exact opposite of
  // what this override used to say ('no-console': 'off').
  //
  // Everything the worker writes goes to /var/log/canopy-worker/worker.log, and
  // the CloudWatch agent's multi_line_start_pattern is keyed on the ISO-8601
  // prefix that packages/canopycms/src/worker/log.ts adds. A line WITHOUT that
  // prefix does not become its own event - it is appended to the previous one,
  // inheriting a stale timestamp and losing its severity tag. So the two
  // directories where the invariant is strictest were the two where the only
  // relevant rule was disabled, and the project-wide rule (above) would not have
  // helped anyway: it already allows warn/error/info.
  //
  // Expressed as `no-restricted-syntax` rather than `no-console`, for two
  // reasons that both bit during this change:
  //   1. `no-console` cannot express "allow nothing" - its schema rejects
  //      `allow: []` (minItems 1) - and flat config RETAINS the previous
  //      config's options when a later entry supplies only a severity. So
  //      `'no-console': 'error'` here silently inherited the project-wide
  //      `allow: ['warn', 'error', 'info']` and left console.warn legal in the
  //      worker: a decorative override, the same shape as the bug it fixes.
  //      Verified with `eslint --print-config`.
  //   2. The custom message can name the replacement, which the generic
  //      no-console text cannot.
  // The selector matches any member access on `console`, so .log/.warn/.error/
  // .info/.debug are all caught. `vi.spyOn(console, 'warn')` is not a member
  // access on console and stays legal, which is what the worker log tests need.
  //
  // Glob deliberately `**/`-anchored, matching the override this replaces: the
  // repo-root-relative form ('packages/canopycms/src/worker/**') silently
  // matches NOTHING here. The only two `worker` directories in the repo are
  // packages/canopycms/src/worker and packages/canopycms-cdk/worker.
  {
    files: ['**/worker/**'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='console']",
          message:
            'Bare console writes an UNPREFIXED line to worker.log, which the CloudWatch agent folds into the previous event instead of starting a new one (see worker/log.ts). Use workerLog / workerLogWarn / workerLogError.',
        },
      ],
    },
  },
  // Shared modules that are NOT in a worker directory but that the worker
  // process executes, so the same invariant applies to them. Lint is the only
  // thing that can hold this line: they are legitimately plain `console` under
  // Lambda, so the fix is to route them through utils/logger.ts's canopyLog*
  // (which IS console until a worker entrypoint installs the prefixing one) -
  // and this override is what stops a future bare console.warn from
  // reintroducing the unprefixed line the helpers exist to prevent.
  //   github-service.ts  - the worker's own Octokit fires its rate-limit
  //                        callbacks; PR create/update is a worker task.
  //   branch-registry.ts - registry regeneration, reached from every worker
  //                        `meta.save()`.
  //   operating-mode/deployment-name.ts - imported directly by cms-worker.ts and
  //                        resolved inside start(); its env-vs-config mismatch
  //                        warning is precisely what an operator greps for.
  //
  // This list is a standing hazard: it is maintained by hand, so a module that
  // BECOMES worker-reachable later is not covered until someone remembers to add
  // it. deployment-name.ts was missed on the first pass for exactly that reason
  // (the sweep went by directory name and by the modules the finding named,
  // rather than by the worker's real import graph). If this list grows much
  // further, derive it from the import graph instead of curating it.
  {
    files: [
      '**/canopycms/src/github-service.ts',
      '**/canopycms/src/branch-registry.ts',
      '**/canopycms/src/operating-mode/deployment-name.ts',
    ],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='console']",
          message:
            'This module runs inside the worker process, where a bare console line reaches worker.log without the ISO-8601 prefix the CloudWatch agent needs (see worker/log.ts). Use canopyLog / canopyLogWarn / canopyLogError from utils/logger.ts - they ARE console until a worker entrypoint installs the prefixing logger.',
        },
      ],
    },
  },
  // ...except log.ts itself, which IS the wrapper: it is the one module in those
  // directories that must call console. Must come AFTER the ban above - later
  // overrides win in flat config.
  //
  // Their *test* files are deliberately NOT exempted here. Note the test-file
  // override further down turns off `no-console` only, so `no-restricted-syntax`
  // stays active in worker tests - which is fine today (no worker test uses a
  // `console.x` member access; `vi.spyOn(console, 'warn')` passes a bare
  // identifier and does not match the selector) but means the first worker test
  // that writes `vi.mocked(console.log)` will hit a message about worker.log
  // that has nothing to do with its test. Add the exemption then, not now.
  {
    files: ['**/worker/log.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Debug utility and the shared logger indirection wrap console by design
  {
    files: ['**/utils/debug.ts', '**/utils/logger.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Storybook stories: render() calls hooks (expected), mock handlers use console
  {
    files: ['**/*.stories.{ts,tsx,jsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'no-console': 'off',
    },
  },
  // Test files: more permissive on any, console, and require()
  {
    files: ['**/*.test.{ts,tsx}', '**/__test__/**', '**/__integration__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },
  // Test utilities: any is lower-risk in test helpers
  {
    files: ['**/test-utils/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Prettier must be last to override conflicting style rules
  eslintConfigPrettier,
]

export default eslintConfig
