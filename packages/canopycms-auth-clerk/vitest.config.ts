import { defineConfig } from 'vitest/config'
import { quietTestOutput } from '../../vitest.shared'

export default defineConfig({
  test: {
    // `dot` reporter + the CI `onConsoleLog` guard, shared with every package.
    ...quietTestOutput,
    // Inlined so vi.mock reaches the provider's own imports (skip-set-active-action.contract.test).
    server: { deps: { inline: ['@clerk/nextjs'] } },
  },
})
