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
 * Mirrors DevAuthPlugin's shape: implements verifyTokenOnly but does NOT set
 * verifiesCredentials, proving the guard cannot rely on the presence of
 * verifyTokenOnly as a substitute signal.
 */
const unmarkedDevPlugin: AuthPlugin = {
  ...basePlugin,
  verifyTokenOnly: async () => ({ userId: 'dev_user' }),
}

/** A verifying plugin (e.g. Clerk): has verifyTokenOnly AND verifiesCredentials: true. */
const verifyingPlugin: AuthPlugin = {
  ...basePlugin,
  verifiesCredentials: true,
  verifyTokenOnly: async () => ({ userId: 'real_user' }),
}

describe('assertAuthPluginAllowedForMode', () => {
  it('throws when a plugin without verifiesCredentials is used with mode prod', () => {
    expect(() => assertAuthPluginAllowedForMode(unmarkedDevPlugin, 'prod')).toThrow(
      /mode: 'prod'.*does not affirm.*verifiesCredentials/,
    )
  })

  it('mentions the remediation (verifying plugin) in the error message', () => {
    expect(() => assertAuthPluginAllowedForMode(unmarkedDevPlugin, 'prod')).toThrow(
      /createClerkAuthPlugin/,
    )
  })

  it('accepts an unmarked plugin in dev mode', () => {
    expect(() => assertAuthPluginAllowedForMode(unmarkedDevPlugin, 'dev')).not.toThrow()
  })

  it('accepts a verifying plugin (verifiesCredentials: true) in prod', () => {
    expect(() => assertAuthPluginAllowedForMode(verifyingPlugin, 'prod')).not.toThrow()
  })

  it('rejects a plain plugin without the marker in prod (allowlist, not denylist)', () => {
    expect(() => assertAuthPluginAllowedForMode(basePlugin, 'prod')).toThrow(/verifiesCredentials/)
  })

  it('does nothing when mode is undefined (validated elsewhere)', () => {
    expect(() => assertAuthPluginAllowedForMode(unmarkedDevPlugin, undefined)).not.toThrow()
  })
})
