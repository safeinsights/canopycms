import type { CanopyConfig, CanopyConfigInput } from './config'
import { defineCanopyConfig } from './config'

const FALLBACK_AUTHOR = {
  gitBotAuthorName: 'CanopyCMS Test Bot',
  gitBotAuthorEmail: 'canopycms-test@example.com',
}

type TestConfigInput = Omit<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail'> &
  Partial<Pick<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail'>>

/**
 * Test-only helper that fills required author fields for convenience.
 * Do not use in production code; prefer defineCanopyConfig.
 */
export const defineCanopyTestConfig = (
  config: TestConfigInput,
  overrides?: Partial<CanopyConfigInput>,
): CanopyConfig =>
  defineCanopyConfig({
    ...FALLBACK_AUTHOR,
    ...config,
    ...(overrides ?? {}),
  })
