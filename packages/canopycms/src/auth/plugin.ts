import type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'
import type { OperatingMode } from '../operating-mode/types'

/** Implement this to integrate an auth system (Clerk, Auth0, NextAuth, ...). */
export interface AuthPlugin {
  /**
   * Affirmative allowlist marker: true ONLY on plugins that cryptographically
   * verify credentials. In 'prod', assertAuthPluginAllowedForMode() rejects any
   * plugin without it, so a plugin that forgets the marker fails closed.
   */
  readonly verifiesCredentials?: boolean

  /**
   * Authenticate from a request context, returning identity without final
   * groups; core applies bootstrap admins.
   *
   * CREDENTIAL failures (missing, invalid or expired token) RESOLVE to
   * `{ success: false }` and map to a 401. CONFIGURATION errors (an absent
   * CLERK_SECRET_KEY, say) may THROW instead: they are operator mistakes, and
   * belong in a loud 500 rather than a quiet auth denial. A custom adapter
   * calling this directly must be ready for that rejection.
   */
  authenticate(context: unknown): Promise<AuthenticationResult>

  /** For the permission-management UI. */
  searchUsers(query: string, limit?: number): Promise<UserSearchResult[]>

  getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null>

  getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null>

  /** For permission UI dropdowns. */
  listGroups(limit?: number): Promise<GroupMetadata[]>

  /** For the group-management UI; only providers with groups need it. */
  searchExternalGroups?(query: string): Promise<Array<{ id: CanopyGroupId; name: string }>>

  /**
   * Token-only verification: no metadata lookup, no network. When present,
   * createNextCanopyContext wraps this plugin with CachingAuthPlugin in both
   * modes, over a cache the worker daemon populates.
   */
  verifyTokenOnly?(context: unknown): Promise<{ userId: CanopyUserId } | null>

  /**
   * Builds the refresher the worker daemon and CLI run-once use to populate the
   * file-based auth cache. Undefined when this plugin cannot refresh (no
   * credentials, say).
   */
  createCacheRefresher?(
    cachePath: string,
  ): (() => Promise<{ userCount: number; groupCount: number }>) | undefined
}

export type AuthPluginFactory<TConfig = unknown> = (config: TConfig) => AuthPlugin

/**
 * Fail closed in prod: an ALLOWLIST, so a plugin passes only by setting
 * `verifiesCredentials: true`. DevAuthPlugin, and any plugin that forgets the
 * marker, trusts request headers without cryptographic verification, so
 * accepting one in 'prod' would let any caller impersonate any user, admins
 * included, with a header like `X-Test-User: admin`. Absence of
 * `verifyTokenOnly` is NOT a substitute for the marker — the dev plugin
 * implements that too.
 *
 * Call this wherever an adopter-provided plugin meets the operating mode
 * (framework wrappers, request handlers) BEFORE the plugin is wrapped or used.
 *
 * @throws Error when mode is 'prod' and the plugin does not set `verifiesCredentials: true`
 */
export function assertAuthPluginAllowedForMode(
  plugin: AuthPlugin,
  mode: OperatingMode | undefined,
): void {
  if (mode === 'prod' && plugin.verifiesCredentials !== true) {
    throw new Error(
      "CanopyCMS: an auth plugin was configured with mode: 'prod' but does not affirm " +
        '`verifiesCredentials: true`. This plugin performs no real credential verification, ' +
        'so anyone could impersonate any user (including admins). Configure a verifying auth ' +
        "plugin for production (e.g. createClerkAuthPlugin from 'canopycms-auth-clerk' with " +
        "CLERK_JWT_KEY set), or run with mode: 'dev' for local development.",
    )
  }
}
