import js from '@eslint/js'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
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
    ],
  },
  // Base recommended rules
  js.configs.recommended,
  // TypeScript recommended rules
  ...typescriptEslint.configs.recommended,
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
  // Worker daemon uses console for operational logging
  {
    files: ['**/worker/**'],
    rules: {
      'no-console': 'off',
    },
  },
  // Debug utility wraps console by design
  {
    files: ['**/utils/debug.ts'],
    rules: {
      'no-console': 'off',
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
