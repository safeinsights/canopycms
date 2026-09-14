/**
 * The shared "authenticate -> resolve internal groups -> merge into CanopyUser"
 * pipeline: the single resolution point for `http/handler.ts` and
 * `canopycms-next`'s `context-wrapper.ts`, so the two cannot diverge over where
 * group-based privileges come from.
 *
 * canopyLogWarn, not console.warn: nothing prevents this module from becoming
 * reachable from the worker's runtime import closure, and the "no admins
 * configured" warning must not be folded silently into an unrelated worker.log
 * event (see utils/logger.ts).
 */
import { canopyLogWarn } from './utils/logger'
import type { AuthenticationResult } from './auth/types'
import type { CanopyUser } from './user'
import { authResultToCanopyUser } from './user'
import { loadInternalGroups, RESERVED_GROUPS, type InternalGroup } from './authorization'
import type { OperatingMode } from './operating-mode'

/** Module-level: warn at most once per process. */
let warnedNoAdmins = false

/** Test-only: reset the once-per-process "no admins configured" warning latch. */
export function resetResolveCanopyUserWarningForTests(): void {
  warnedNoAdmins = false
}

export interface ResolveCanopyUserDeps {
  /**
   * Resolves (and ensures) the settings workspace root. Internal groups are the
   * single source of truth for group-based privileges and MUST be loaded from
   * here — the same root `createContentAccessChecker` (authorization/content.ts)
   * uses for path permissions — never from a content branch clone.
   *
   * MUST THROW if the settings workspace cannot be ensured, matching
   * `createContentAccessChecker`'s fail-loud contract: a silent fallback to an
   * empty group list reads as "no privileges", which is a silent authorization
   * change rather than a safe degradation.
   */
  getSettingsBranchRoot: () => Promise<string>
  mode: OperatingMode
  bootstrapAdminIds: Set<string>
}

function warnIfNoAdmins(internalGroups: InternalGroup[], bootstrapAdminIds: Set<string>): void {
  if (warnedNoAdmins) return
  const adminsGroup = internalGroups.find((g) => g.id === RESERVED_GROUPS.ADMINS)
  const hasAdmins = (adminsGroup?.members.length ?? 0) > 0 || bootstrapAdminIds.size > 0
  if (!hasAdmins) {
    canopyLogWarn(
      'CanopyCMS: No admin users configured. Set CANOPY_BOOTSTRAP_ADMIN_IDS or add members to the Admins group.',
    )
  }
  warnedNoAdmins = true
}

/**
 * Resolve the CanopyUser for a request: load internal groups from the settings
 * workspace and merge them, plus bootstrap admins, into an authentication result
 * via `authResultToCanopyUser`. Framework-agnostic — callers supply the
 * already-computed `authResult` and a small deps bag from `CanopyServices`.
 */
export async function resolveCanopyUser(
  authResult: AuthenticationResult,
  deps: ResolveCanopyUserDeps,
): Promise<CanopyUser> {
  const settingsRoot = await deps.getSettingsBranchRoot()
  const internalGroups = await loadInternalGroups(settingsRoot, deps.mode, deps.bootstrapAdminIds)

  warnIfNoAdmins(internalGroups, deps.bootstrapAdminIds)

  return authResultToCanopyUser(authResult, deps.bootstrapAdminIds, internalGroups)
}
