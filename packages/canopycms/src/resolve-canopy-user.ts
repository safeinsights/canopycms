/**
 * Shared "authenticate -> resolve internal groups -> merge into CanopyUser"
 * pipeline.
 *
 * This used to be duplicated between `http/handler.ts` (the core API
 * handler) and `canopycms-next`'s `context-wrapper.ts` (Next.js SSR user
 * extraction) - including a module-level `warnedNoAdmins` flag in each copy.
 * The duplication let the two drift: `http/handler.ts` loaded internal
 * groups from the BASE BRANCH content clone's `groups.json`, which nothing
 * in the product ever writes (writes go to the settings workspace via
 * `mutateGroupsFile` - `api/groups.ts`), so group-based privileges never
 * actually took effect. Consolidating the pipeline here means both callers
 * read from the same place and cannot silently diverge again.
 *
 * canopyLogWarn, not console.warn: this module has no worker-specific logic,
 * but nothing prevents it from becoming reachable from the worker's runtime
 * import closure later, and the existing "no admins configured" warning is
 * exactly the kind of operationally interesting line that must not be
 * silently folded into an unrelated worker.log event (see utils/logger.ts).
 */
import { canopyLogWarn } from './utils/logger'
import type { AuthenticationResult } from './auth/types'
import type { CanopyUser } from './user'
import { authResultToCanopyUser } from './user'
import { loadInternalGroups, RESERVED_GROUPS, type InternalGroup } from './authorization'
import type { OperatingMode } from './operating-mode'

/** Module-level, matching the pre-extraction behavior: warn at most once per process. */
let warnedNoAdmins = false

/** Test-only: reset the once-per-process "no admins configured" warning latch. */
export function resetResolveCanopyUserWarningForTests(): void {
  warnedNoAdmins = false
}

export interface ResolveCanopyUserDeps {
  /**
   * Resolves (and ensures) the settings workspace root. Internal groups are
   * the single source of truth for group-based privileges and MUST be
   * loaded from here — the same root `createContentAccessChecker`
   * (authorization/content.ts) uses for path permissions — never from a
   * content branch clone.
   *
   * Must THROW if the settings workspace cannot be ensured, matching
   * `createContentAccessChecker`'s fail-loud contract: a caught error here
   * and a silent fallback to an empty group list would read as "no
   * privileges", which is a silent authorization change, not a safe
   * degradation.
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
 * Resolve the CanopyUser for a request: load internal groups from the
 * settings workspace and merge them (plus bootstrap admins) into an
 * authentication result via `authResultToCanopyUser`.
 *
 * Framework-agnostic: callers supply the already-computed `authResult` (from
 * whatever auth-plugin invocation their transport uses) and a small deps
 * bag drawn from `CanopyServices`.
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
