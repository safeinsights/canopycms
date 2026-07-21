import type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'
import type { OperatingMode } from '../operating-mode/types'

/**
 * Abstract auth provider interface.
 * Implement this to integrate different auth systems (Clerk, Auth0, NextAuth, etc.)
 */
export interface AuthPlugin {
  /**
   * Affirmative allowlist marker: set to true ONLY on plugins that
   * cryptographically verify credentials (e.g. Clerk JWT verification).
   * assertAuthPluginAllowedForMode() rejects any plugin without this marker
   * whenever the operating mode is 'prod' — absence fails closed, so a
   * third-party plugin that forgets the marker is rejected, not accepted.
   */
  readonly verifiesCredentials?: boolean

  /**
   * Authenticate user from request context.
   * Returns user identity (without final groups) - core will apply bootstrap admins.
   *
   * @param context - Framework-specific context (CanopyRequest, headers, etc.)
   * @returns AuthenticationResult with user identity or error
   */
  authenticate(context: unknown): Promise<AuthenticationResult>

  /**
   * Search for users (for permission management UI)
   * @param query - Search string (email, name, etc.)
   * @param limit - Max results (default 10)
   */
  searchUsers(query: string, limit?: number): Promise<UserSearchResult[]>

  /**
   * Get detailed user metadata by ID
   */
  getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null>

  /**
   * Get group/organization metadata by ID
   */
  getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null>

  /**
   * List all groups (for permission UI dropdowns)
   */
  listGroups(limit?: number): Promise<GroupMetadata[]>

  /**
   * Search for external groups/organizations (for group management UI)
   * Optional - only needed if auth provider supports external groups
   * @param query - Search string (name, ID, etc.)
   */
  searchExternalGroups?(query: string): Promise<Array<{ id: CanopyGroupId; name: string }>>

  /**
   * Optional: lightweight token-only verification (no user metadata lookup, no network).
   * When present, createNextCanopyContext automatically wraps this plugin with
   * CachingAuthPlugin in prod/dev modes. The cache is populated by the worker daemon.
   */
  verifyTokenOnly?(context: unknown): Promise<{ userId: CanopyUserId } | null>

  /**
   * Optional: create a function that refreshes the auth cache for this plugin.
   * Used by the worker daemon and CLI run-once to populate the file-based auth cache.
   * Returns undefined if this plugin doesn't support cache refresh (e.g., missing credentials).
   */
  createCacheRefresher?(
    cachePath: string,
  ): (() => Promise<{ userCount: number; groupCount: number }>) | undefined
}

/**
 * Factory function type for creating auth plugins
 */
export type AuthPluginFactory<TConfig = unknown> = (config: TConfig) => AuthPlugin

/**
 * Fail closed: only allow auth plugins that affirmatively declare real
 * credential verification when the CMS runs in production.
 *
 * This is an allowlist, not a denylist: a plugin must set
 * `verifiesCredentials: true` to pass this guard in prod. DevAuthPlugin (and
 * any third-party plugin that forgets to set the marker) trusts request
 * headers/cookies without cryptographic verification, so accepting it with
 * mode 'prod' would let any caller impersonate any user — including admins —
 * by sending a header like `X-Test-User: admin`. Call this wherever an
 * adopter-provided auth plugin meets the operating mode (framework wrappers,
 * request handlers) BEFORE the plugin is wrapped or used.
 *
 * Note: checking for the absence of verifyTokenOnly is NOT a substitute for
 * this marker — the dev plugin implements verifyTokenOnly too.
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
        "CLERK_SECRET_KEY set), or run with mode: 'dev' for local development.",
    )
  }
}
