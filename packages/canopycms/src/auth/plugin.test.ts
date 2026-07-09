import { describe, expect, it } from 'vitest'
import { assertAuthPluginAllowedForMode } from './plugin'
import type { AuthPlugin } from './plugin'

/** Minimal AuthPlugin base for building test plugins. */
const basePlugin: AuthPlugin = {
  authenticate: async () => ({ success: false, error: 'not used' }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

/**
 * Mirrors DevAuthPlugin's shape: marked insecure AND implements verifyTokenOnly,
 * proving the guard cannot rely on the absence of verifyTokenOnly.
 */
const insecureDevPlugin: AuthPlugin = {
  ...basePlugin,
  insecureDevOnly: true,
  verifyTokenOnly: async () => ({ userId: 'dev_user' }),
}

/** A verifying plugin (e.g. Clerk): has verifyTokenOnly, no insecure marker. */
const verifyingPlugin: AuthPlugin = {
  ...basePlugin,
  verifyTokenOnly: async () => ({ userId: 'real_user' }),
}

describe('assertAuthPluginAllowedForMode', () => {
  it('throws when an insecure dev-only plugin is used with mode prod', () => {
    expect(() => assertAuthPluginAllowedForMode(insecureDevPlugin, 'prod')).toThrow(
      /dev\/insecure auth plugin.*mode: 'prod'/,
    )
  })

  it('mentions the remediation (verifying plugin) in the error message', () => {
    expect(() => assertAuthPluginAllowedForMode(insecureDevPlugin, 'prod')).toThrow(
      /createClerkAuthPlugin/,
    )
  })

  it('accepts an insecure dev-only plugin in dev mode', () => {
    expect(() => assertAuthPluginAllowedForMode(insecureDevPlugin, 'dev')).not.toThrow()
  })

  it('accepts a verifying plugin (verifyTokenOnly, no marker) in prod', () => {
    expect(() => assertAuthPluginAllowedForMode(verifyingPlugin, 'prod')).not.toThrow()
  })

  it('accepts a plain plugin without the marker in prod', () => {
    expect(() => assertAuthPluginAllowedForMode(basePlugin, 'prod')).not.toThrow()
  })

  it('does nothing when mode is undefined (validated elsewhere)', () => {
    expect(() => assertAuthPluginAllowedForMode(insecureDevPlugin, undefined)).not.toThrow()
  })
})
