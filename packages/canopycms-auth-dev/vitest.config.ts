import { defineConfig } from 'vitest/config'
import { quietTestOutput } from '../../vitest.shared'

export default defineConfig({
  test: {
    // `dot` reporter + the CI `onConsoleLog` guard, shared with every package.
    ...quietTestOutput,
  },
})
