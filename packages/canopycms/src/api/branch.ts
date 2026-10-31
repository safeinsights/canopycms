import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { BranchAccessControl, BranchContext, BranchHold, BranchMetadata } from '../types'
import { BranchWorkspaceManager, type ProvisionOutcome } from '../branch-workspace'
import {
  BranchDirOccupiedError,
  BranchProvisioningBusyError,
  deletingDirName,
  removeLeftoverDir,
} from '../branch-provisioning'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withOccFileLock } from '../utils/occ-json-write'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { isCreatorsRecentBranch } from './branch-create-window'
import { defineEndpoint } from './route-builder'
import { createDebugLogger } from '../utils/debug'
import { clientOperatingStrategy } from '../operating-mode'
import { isNotFoundError, getErrorMessage, sanitizeErrorMessage } from '../utils/error'
import { filePathExists } from '../utils/fs'
import { isNetworkRemoteUrl } from '../utils/git'
import {
  parseCreatedBranchName,
  sanitizeBranchName,
  RESERVED_SETTINGS_BRANCH_PREFIX,
  isSettingsBranchName,
} from '../paths'
import { GitManager } from '../git-manager'
import { syncDeleteRemoteBranch } from './github-sync'
import { branchNameSchema, branchParamSchema } from './validators'
import { baseBranchOf } from '../utils/base-branch'
import { shortNameOf } from '../branch-param'
import { namespaceAncestors } from '../operating-mode/branch-namespace'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import { readWorkerStatus } from '../task-queue/worker-status'
import type { UserProfile } from '../auth/types'
import { lookupUserProfiles } from '../auth/user-metadata-lookup'

const log = createDebugLogger({ prefix: 'BranchAPI' })

/**
 * A listed branch plus server-computed protected-base-branch flags (see
 * authorization/protected-branch.ts). Optional on the wire, matching the
 * `defaultBranch` precedent -- this server always emits all three, but an
 * older server won't. That optionality does not make the two directions
 * symmetric: the editor client now defaults every missing flag fail-closed
 * (`?? true`), so a NEW client talking to an OLD server that omits these
 * fields degrades to fully locked -- read-only, Submit hidden, and (see
 * `branchLockState`'s `branchDataUnavailable`) a "could not be loaded" status --
 * rather than silently behaving as if nothing changed. That is by design:
 * wire compatibility here means "doesn't break", not "behaves the same".
 */
export interface BranchListItem extends Omit<
  BranchMetadata,
  | 'review'
  | 'keptOverGitHub'
  | 'lastGitHubTip'
  | 'rewrittenOnGitHub'
  | 'submitUnfinished'
  | 'unpublishedAtMerge'
  | 'rebaseFailure'
  | 'pullRequestHold'
> {
  /** What is stuck and needs a person, for the branch card. Names no file. */
  hold?: BranchHold
  /** The last submit didn't finish, which the server refuses Approve for. */
  approveBlocked?: boolean
  /**
   * What pull request links carry for this branch, which `?branch=` and the `/:branch` segment
   * accept beside `name` (branch-param.ts's `shortNameOf`): `name` less the namespace for a branch
   * in it, else the full `name`.
   */
  shortName?: string
  isProtected?: boolean
  readOnly?: boolean
  /**
   * True when content writes are rejected -- base-branch read-only OR a status
   * lock (submitted/approved/archived). The editor renders its locked state off
   * this instead of re-deriving the status rule client-side; `readOnly` still
   * distinguishes WHICH lock applies, for the status copy.
   */
  writeBlocked?: boolean
  /**
   * Populated from {@link BranchWriteProtection.submitBlockedIncludingStatus},
   * or true for a branch rewritten on GitHub
   * -- READ THAT DOC COMMENT before touching this field. On the wire this
   * name means the COMPOUND answer (base-branch OR non-'editing' status),
   * mirroring how `writeBlocked` above is the compound of `readOnly` + status
   * while `readOnly` alone is just the base-branch part: `isProtected` /
   * `submitBlocked` here is the same two-part shape (protected-branch.ts's
   * `submitBlockedIncludingStatus = protection.submitBlocked || status !==
   * 'editing'`). Do NOT "simplify" this to `protection.submitBlocked` --
   * that field means ONLY "is the base branch" (it is what
   * `api/guards.ts`'s `submittableBranch` guard reads, and that guard must
   * keep refusing the base branch regardless of status), so swapping it in
   * here would silently stop blocking submit on a submitted/approved/
   * archived non-base branch.
   */
  submitBlocked?: boolean
  /**
   * How many ACL entries {@link toBranchListItem} left out of `access` for a caller without the
   * privileged user lookup. Absent for a privileged caller, who gets the whole list.
   */
  withheldAccess?: { users: number; groups: number }
}

/**
 * Response type for branch creation and the workflow transitions. Carries the
 * list-item shape (server-computed flags included) so the editor can show the
 * result without waiting for a listing that may lag behind it.
 */
export type BranchListItemResponse = ApiResponse<{
  branch: BranchListItem
  /** Set when the request succeeded but a secondary effect failed; show it to the user. */
  warning?: string
}>

/** Response type for listing branches */
export type BranchListResponse = ApiResponse<{
  branches: BranchListItem[]
  /**
   * The server's effective default branch (the detected active branch in dev
   * mode). Clients without an explicitly pinned branch should open this one.
   * Optional on the wire so older servers remain compatible.
   */
  defaultBranch?: string
  /** Profiles of the listed branches' creators, in no order; unknown ids are absent. */
  users: UserProfile[]
}>

/** Response type for branch deletion */
export type BranchDeleteResponse = ApiResponse<{
  deleted: boolean
  /**
   * Set when branch.json was removed (so the branch is logically gone from
   * the registry) but the full directory removal failed -- an orphan clone
   * persists on disk, invisible to the API, until manually cleaned up.
   */
  cleanupWarning?: string
}>

const createBranchBodySchema = z.object({
  branch: branchNameSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  access: z
    .object({
      allowedUsers: z.array(z.string()).optional(),
      allowedGroups: z.array(z.string()).optional(),
    })
    .optional(),
})

const updateBranchAccessBodySchema = z.object({
  allowedUsers: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional(),
})

import {
  isPrivileged,
  isAdmin,
  loadPathPermissions,
  getBranchProtection,
  getBranchWriteProtection,
} from '../authorization'
import type { PathPermission } from '../config'
import type { CanopyUser } from '../user'
import { operatingStrategy } from '../operating-mode'

/**
 * Returns true if:
 * - User is Admin or Reviewer (privileged)
 * - User has edit access to at least one path via pathPermissions rules
 * - No path permissions are defined (open access)
 * @internal Exported for tests.
 */
export const canCreateBranch = (
  user: CanopyUser,
  pathPermissions: PathPermission[],
): { allowed: boolean; reason: string } => {
  if (isPrivileged(user.groups)) {
    return { allowed: true, reason: 'privileged_user' }
  }

  if (pathPermissions.length === 0) {
    return { allowed: true, reason: 'no_restrictions' }
  }

  for (const rule of pathPermissions) {
    const editTarget = rule.edit
    if (!editTarget) continue

    const hasUserConstraint = !!editTarget.allowedUsers?.length
    const hasGroupConstraint = !!editTarget.allowedGroups?.length
    if (!hasUserConstraint && !hasGroupConstraint) {
      return { allowed: true, reason: 'open_path_rule' }
    }

    const matchesUser = hasUserConstraint && editTarget.allowedUsers?.includes(user.userId)
    const matchesGroup =
      hasGroupConstraint && user.groups?.some((gid) => editTarget.allowedGroups?.includes(gid))

    if (matchesUser || matchesGroup) {
      return { allowed: true, reason: 'path_access' }
    }
  }

  return { allowed: false, reason: 'no_path_access' }
}

export interface CreateBranchBody {
  branch: string
  title?: string
  description?: string
  access?: BranchMetadata['access']
}

/**
 * Read-only resolution of the local `remote.git` mirror's path, or undefined
 * when none is configured/auto-detectable (ordinary dev mode) -- callers must
 * still check `isNetworkRemoteUrl`/`filePathExists` before touching it.
 *
 * Resolving remote.git's path must not have side effects:
 * GitManager.resolveRemoteUrl is NOT safe to call for this -- in dev mode its
 * shouldAutoInitLocal branch CREATES a simulated remote as a side effect of
 * merely asking where one would be. So this resolves read-only, mirroring
 * resolveRemoteUrl's own precedence for its first three sources only
 * (config.defaultRemoteUrl -> env var -> the strategy's auto-detect path);
 * resolveRemoteUrl's fourth source (auto-init) is exactly the side effect
 * being avoided, so it has no read-only equivalent here.
 *
 * Shared by createBranchHandler (create-time collision check against the
 * mirror) and deleteBranchHandler (removing the deleted branch's stale local
 * head from the mirror) -- the two halves of the same lifecycle: what create
 * checks, delete must clean up.
 */
const resolveReadOnlyMirrorPath = (
  ctx: ApiContext,
  strategy: ReturnType<typeof operatingStrategy>,
): string | undefined => {
  const remoteUrlConfig = strategy.getRemoteUrlConfig()
  return (
    ctx.services.config.defaultRemoteUrl ??
    process.env[remoteUrlConfig.envVarName] ??
    remoteUrlConfig.autoDetectRemotePath
  )
}

/**
 * The ACL as `viewer` may see it. Without the privileged user lookup, a caller gets only the
 * entries naming them or their groups, which is all the editor's membership checks read, and a
 * count of the rest: the other ids name people that lookup keeps from them.
 */
const accessForViewer = (
  access: BranchAccessControl,
  viewer: CanopyUser,
): Pick<BranchListItem, 'access' | 'withheldAccess'> => {
  if (isPrivileged(viewer.groups)) return { access }
  const viewerGroups: readonly string[] = viewer.groups ?? []
  const allowedUsers = access.allowedUsers?.filter((id) => id === viewer.userId)
  const allowedGroups = access.allowedGroups?.filter((id) => viewerGroups.includes(id))
  return {
    access: {
      ...access,
      ...(allowedUsers && { allowedUsers }),
      ...(allowedGroups && { allowedGroups }),
    },
    withheldAccess: {
      users: (access.allowedUsers?.length ?? 0) - (allowedUsers?.length ?? 0),
      groups: (access.allowedGroups?.length ?? 0) - (allowedGroups?.length ?? 0),
    },
  }
}

/**
 * A branch as `viewer` may see it, with server-computed protected-base-branch flags. Every
 * branch response outside the admin-only repairs goes through here. Reads config per call so
 * dev-mode refreshActiveBranch() updates are reflected.
 */
export const toBranchListItem = (
  config: ApiContext['services']['config'],
  branch: BranchMetadata,
  viewer: CanopyUser,
): BranchListItem => {
  const protection = getBranchWriteProtection(config, branch.name, branch.baseBranch, branch.status)
  // `review` names the reviewer, whom the editor has no use for. `keptOverGitHub` and
  // `rebaseFailure` can name files, which a viewer's path rules can hide; System Health reads
  // failures from the admin endpoint. The others are the worker's.
  const {
    review: _review,
    keptOverGitHub: _kept,
    lastGitHubTip: _tip,
    rewrittenOnGitHub: _rewritten,
    submitUnfinished: _unfinished,
    unpublishedAtMerge: _unpublished,
    rebaseFailure: _failure,
    pullRequestHold,
    ...listed
  } = branch
  const inReview = branch.status === 'submitted' || branch.status === 'approved'
  const rewritten = branch.rewrittenOnGitHub !== undefined && branch.status !== 'archived'
  const hold: BranchHold | undefined = rewritten
    ? { kind: 'rewritten' }
    : !inReview
      ? branch.unpublishedAtMerge
        ? { kind: 'unpublished-at-merge' }
        : undefined
      : branch.submitUnfinished
        ? { kind: 'submit-unfinished', opened: branch.pullRequestNumber !== undefined }
        : pullRequestHold
  return {
    ...listed,
    hold,
    approveBlocked: (inReview && branch.submitUnfinished) || undefined,
    shortName: shortNameOf(config, branch.name),
    ...accessForViewer(branch.access ?? {}, viewer),
    isProtected: protection.isProtected,
    readOnly: protection.readOnly,
    writeBlocked: protection.writeBlocked,
    // The worker refuses to push such a branch, so a submit could only fail later.
    submitBlocked: protection.submitBlockedIncludingStatus || rewritten,
  }
}

/**
 * The API's static top-level route segments, which the router ranks above `/:branch`, so a branch
 * whose short name is one would be shadowed. `http/router.test.ts` holds this list to the router.
 * @internal Exported for tests.
 */
export const TOP_LEVEL_ROUTE_SEGMENTS: readonly string[] = [
  'admin',
  'assets',
  'branches',
  'groups',
  'permissions',
  'users',
  'whoami',
]

/**
 * The names of the branches outside `namespace` a URL can reach, which neither a new branch's
 * short name nor its ref may take, since the base and active branches resolve first and a short
 * name would shadow the rest (branch-param.ts): the base, the configured active branch, every
 * workspace outside the namespace, and the exact names the GitHub gateway protects as the last git
 * sync recorded them in worker-status.json. Namespace
 * workspaces are left out, so a creator's retry of a create that already landed reaches the key
 * check's idempotent answer instead of a refusal.
 */
const outsideBranchNames = (
  config: ApiContext['services']['config'],
  namespace: string,
  listed: readonly BranchContext[],
  gatewayProtected: readonly string[],
): Set<string> => {
  const base = baseBranchOf(config)
  return new Set([
    base,
    config.defaultActiveBranch ?? base,
    ...listed.map((context) => context.branch.name).filter((name) => !name.startsWith(namespace)),
    ...gatewayProtected,
  ])
}

/** @internal Exported for tests. */
export const createBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof createBranchBodySchema>,
): Promise<BranchListItemResponse> => {
  return log.timed('api', 'createBranch', async () => {
    const { config } = ctx.services
    const strategy = operatingStrategy(config.mode)
    // Every branch an editor creates is in the namespace the GitHub gateway writes
    // (worker/branch-policy.ts): its ref is the namespace followed by the typed name, sanitized.
    let namespace: string
    try {
      namespace = strategy.getBranchNamespace(config)
    } catch (err: unknown) {
      return {
        ok: false,
        status: 500,
        error: `Branches cannot be created until an administrator fixes the branch namespace: ${getErrorMessage(err)}`,
      }
    }
    const { workerStatus } = await readWorkerStatus(getTaskQueueDir(config))
    const gatewayNamespace = workerStatus?.gatewayBranchNamespace
    // The worker reports the namespace once a git sync reads one from the gateway's health
    // (worker/git-sync.ts). A worker that predates the namespace never reports one, and its rebase
    // loop renames a namespace branch to its directory, which no request then resolves. Where
    // branches publish through the worker, creation waits for the report.
    if (gatewayNamespace === undefined && strategy.supportsPullRequests()) {
      return {
        ok: false,
        status: 503,
        error:
          "Branches cannot be created yet: the CMS worker has not reported the GitHub gateway's " +
          'branch namespace. Ask an administrator to check that the worker (canopycms-cdk) runs ' +
          'this release and that its git sync reaches the gateway, then try again.',
      }
    }
    if (gatewayNamespace !== undefined && gatewayNamespace !== namespace) {
      return {
        ok: false,
        status: 409,
        error:
          `Branches cannot be created: this CMS creates them in "${namespace}", but the GitHub ` +
          `gateway publishes only branches in "${gatewayNamespace}", so none could be published. ` +
          'Ask an administrator to make the two agree.',
      }
    }

    const named = parseCreatedBranchName(body.branch, namespace)
    if (!named.ok) return nameRefused(400, named.error)
    const { name: branchName, shortName } = named
    const key = sanitizeBranchName(branchName)
    log.debug('api', 'Create branch request', {
      branchName,
      userId: req.user.userId,
    })

    // Scope note: the remote-mirror check further down applies ONLY to this
    // user-facing creation path; http/handler.ts's auto-create (base/active
    // branches) and loadOrCreateBranchContext provision known names. Every
    // provisioning path, this one included, also refuses a settings branch in
    // BranchWorkspaceManager.openOrCreateBranch.

    // Settings live in a separate directory but share the git remote, so a content branch may not
    // take the settings branch's ref. Compared sanitized, the form git and disk use.
    if (strategy.usesSeparateSettingsBranch()) {
      const settingsBranchName = strategy.getSettingsBranchName(config)
      if (key === sanitizeBranchName(settingsBranchName)) {
        return nameRefused(
          400,
          'Cannot create content branch with settings branch name (git branch name collision)',
        )
      }
    }
    // The handler answers any `/:branch` segment in the settings range as not found
    // (http/handler.ts), so a branch with such a short name could never be opened.
    if (isSettingsBranchName(shortName, strategy.getSettingsBranchName(config))) {
      return nameRefused(
        400,
        `"${shortName}" is a name CanopyCMS keeps for its settings. Choose a different name.`,
      )
    }

    // Reject the base branch name outright, even before the base branch is
    // provisioned. No recorded fork point exists yet for a not-yet-created
    // branch, so this checks config protection only.
    const { isProtected } = getBranchProtection(config, branchName)
    if (isProtected) return nameRefused(400, 'Cannot create a branch with the base branch name')

    if (TOP_LEVEL_ROUTE_SEGMENTS.includes(shortName)) {
      return nameRefused(
        400,
        `"${shortName}" is a name CanopyCMS uses for itself. Choose a different name.`,
      )
    }

    if (!ctx.services.registry) {
      return {
        ok: false,
        status: 400,
        error: 'Branch registry not initialized — ensure the workspace has been initialized',
      }
    }
    const listed = await ctx.services.registry.list()
    const outside = outsideBranchNames(
      config,
      namespace,
      listed,
      workerStatus?.gatewayProtectedBranches ?? [],
    )
    if (outside.has(shortName) || outside.has(branchName)) {
      return nameRefused(
        409,
        `"${shortName}" is already the name of another branch. Choose a different name.`,
      )
    }

    // A name collision with ANY existing branch answers before a clone is paid
    // for. Provisioning never merges into an existing branch either: it reports
    // `exists`, mapped the same way below. Compared by key, the workspace directory.
    const existingBranch = await ctx.services.registry.getByKey(key)
    if (existingBranch) {
      return existingBranchResponse(ctx, req, existingBranch, named)
    }

    // L2: create-time collision check against this deployment's local
    // GitHub mirror (`remote.git`). The CMS Lambda has no internet access
    // (PRIVATE_ISOLATED subnets, no NAT -- see AGENTS.md), so a synchronous
    // GitHub API call at branch-create time is not possible. But remote.git
    // is BOTH this deployment's local git origin AND a mirror of GitHub's
    // view of the repo: worker/git-sync.ts's syncGit() fetches GitHub into it
    // (see GITHUB_TRACKING_REF_PREFIX's doc comment in git-manager.ts) and
    // then reconciles refs/heads/* without touching editor work, so it carries both
    // this deployment's local heads and GitHub's view -- readable offline by
    // this same Lambda, since it resolves to the same EFS inode the worker
    // uses. Reading it here catches a collision with a branch another
    // CanopyCMS deployment sharing this repo (or a direct push to GitHub)
    // already created -- something the local registry check above cannot
    // see -- and a branch named after part of the namespace, which git
    // cannot hold beside any branch in it.
    //
    const resolvedMirrorPath = resolveReadOnlyMirrorPath(ctx, strategy)

    if (!resolvedMirrorPath) {
      // No mirror configured or auto-detected at all. This is the ORDINARY
      // dev-mode case, not an anomaly: DevStrategy's getRemoteUrlConfig()
      // has no autoDetectRemotePath (its simulated remote lives at the
      // relative defaultRemotePath instead), so unless an adopter sets
      // defaultRemoteUrl this resolves to undefined on every create. Logged
      // at debug, not warn, so dev doesn't emit a warning per branch
      // creation for the expected shape. Cross-deployment collisions are a
      // prod concern; dev mode being uncovered here is deliberate.
      //
      // Purely additive guard either way: skip and let creation proceed
      // rather than fail closed -- a genuinely missing remote.git fails
      // loudly a moment later when the branch workspace is cloned from it.
      log.debug('api', 'No remote.git mirror resolved -- skipping create-time collision check')
    } else if (isNetworkRemoteUrl(resolvedMirrorPath)) {
      // A network URL (http(s)/ssh/git) means the internet-less Lambda
      // cannot reach it synchronously (see AGENTS.md's deployment
      // architecture) -- skip quietly, this is expected shape rather than a
      // misconfiguration worth warning about.
      log.debug('api', 'Resolved remote is a network URL -- skipping create-time collision check')
    } else if (!(await filePathExists(resolvedMirrorPath))) {
      // Distinct from "mirror unreadable" below: nothing exists at the
      // resolved path yet.
      log.warn(
        'api',
        'remote.git not found at resolved path -- skipping create-time collision check',
        { path: resolvedMirrorPath },
      )
    } else {
      try {
        for (const ancestor of namespaceAncestors(namespace)) {
          // Local heads too: remote.git cannot take the new branch beside one either.
          if (await GitManager.bareRemoteHasBranch(resolvedMirrorPath, ancestor)) {
            return {
              ok: false,
              status: 409,
              error:
                `Branches cannot be created: a branch named "${ancestor}" exists on the remote, ` +
                'and git cannot hold a branch inside another. Ask an administrator to rename or ' +
                'delete it.',
            }
          }
        }
        const [inside] = await GitManager.bareRemoteBranchesInside(resolvedMirrorPath, branchName)
        if (inside !== undefined) {
          return nameRefused(
            409,
            `"${shortName}" cannot be created: the remote has a branch named "${inside}" inside ` +
              'it, and git cannot hold both. Choose a different name.',
          )
        }
        const collision = await GitManager.bareRemoteHasBranch(
          resolvedMirrorPath,
          branchName,
          // GitHub's view only -- see bareRemoteHasBranch. A local head in
          // remote.git survives an editor-side branch delete forever, so
          // including refs/heads/* here would make the ordinary create ->
          // publish -> merge -> delete -> reuse cycle 409 permanently on a name
          // the user just deleted. Locally-live branches are already rejected
          // by the registry check above.
          { namespaces: 'tracking' },
        )
        if (collision) {
          return nameRefused(
            409,
            `A branch named "${shortName}" already exists on the remote. ` +
              `It may have been created by another CanopyCMS deployment sharing this ` +
              `repository, pushed directly to GitHub, or left behind by an earlier branch ` +
              `of the same name. Choose a different name.`,
          )
        }
        // No collision: GitHub does not have this name. Clear any STALE local
        // head the mirror still carries for it, so this new branch's first
        // publish can't be rejected non-fast-forward against a leftover tip.
        // deleteBranchHandler's cleanup (below) handles the common case, but
        // cannot cover every ordering: when the branch still existed on
        // GitHub at editor-delete time, the sync loop's reconcile re-creates
        // the local head from GitHub's branch within a cycle, and once the
        // GitHub side is later deleted that re-created head stays until the
        // sync loop's next prune, with no registry entry left for the delete
        // path to run against. Healing at REUSE time covers every ordering,
        // however the head got orphaned: the registry check above already
        // proved no live branch owns this name, and the tracking check just
        // proved GitHub doesn't either, so a remaining local head is stale by
        // definition. Best-effort (old-value-guarded
        // against a concurrent push): on failure, creation still proceeds --
        // that is today's status quo, and the publish-time 409 message names
        // this cause.
        try {
          await GitManager.deleteBareRemoteHead(resolvedMirrorPath, branchName)
        } catch (err: unknown) {
          log.warn('api', 'Failed to clear stale mirror head at branch reuse', {
            branch: branchName,
            path: resolvedMirrorPath,
            error: getErrorMessage(err),
          })
        }
      } catch (err: unknown) {
        // Mirror EXISTS but is unreadable (corrupt, permissions, wrong git
        // version, ...) -- distinct from "not found" above. Same
        // purely-additive rationale: skip rather than fail closed; a
        // genuinely broken remote.git fails loudly a moment later when the
        // branch workspace is cloned from it.
        log.warn('api', 'remote.git mirror is unreadable -- skipping create-time collision check', {
          path: resolvedMirrorPath,
          error: getErrorMessage(err),
        })
      }
    }

    // Load path permissions from the base branch's JSON file (the resolved
    // fork point — baked into config at service creation; dev-mode git HEAD
    // when not explicitly configured)
    const baseBranch = baseBranchOf(config)
    const baseBranchContext = await ctx.getBranchContext(baseBranch)

    let pathPermissions: PathPermission[] = []
    if (baseBranchContext) {
      const operatingMode = config.mode
      pathPermissions = await loadPathPermissions(baseBranchContext.branchRoot, operatingMode)
    }

    const canCreate = canCreateBranch(req.user, pathPermissions)
    if (!canCreate.allowed) {
      log.debug('api', 'Permission denied', { reason: canCreate.reason })
      return {
        ok: false,
        status: 403,
        error: 'You do not have permission to create branches',
      }
    }

    const manager = new BranchWorkspaceManager(ctx.services.config)
    let outcome: ProvisionOutcome
    try {
      outcome = await manager.provisionBranch({
        branchName,
        mode: ctx.services.config.mode,
        createdBy: req.user.userId,
        title: body.title,
        description: body.description,
        access: body.access,
      })
    } catch (err: unknown) {
      if (err instanceof BranchProvisioningBusyError) {
        return { ok: false, status: 503, error: err.message }
      }
      if (err instanceof BranchDirOccupiedError) return nameRefused(409, err.message)
      throw err
    }
    if (outcome.kind === 'exists') return existingBranchResponse(ctx, req, outcome.context, named)

    log.debug('api', 'Branch created', { branchName: outcome.context.branch.name })
    return {
      ok: true,
      status: 200,
      data: { branch: toBranchListItem(ctx.services.config, outcome.context.branch, req.user) },
    }
  })
}

/**
 * A create whose key an existing workspace holds: 409, unless that workspace is the branch this
 * create names (`named.name`) and the create is its creator's recent retry. A workspace with
 * another stored name only shares the key, so answering with it would hand back another branch.
 */
const existingBranchResponse = (
  ctx: ApiContext,
  req: ApiRequest,
  existing: BranchContext,
  named: { name: string; shortName: string },
): BranchListItemResponse => {
  if (existing.branch.name !== named.name) {
    return nameRefused(
      409,
      `"${named.shortName}" would clash with the existing branch ` +
        `"${shortNameOf(ctx.services.config, existing.branch.name)}". Choose a different name.`,
    )
  }
  if (isCreatorsRecentBranch(existing.branch, req.user.userId)) {
    return {
      ok: true,
      status: 200,
      data: { branch: toBranchListItem(ctx.services.config, existing.branch, req.user) },
    }
  }
  return nameRefused(409, `A branch named "${named.shortName}" already exists`)
}

/** A create refused for the name it was given, which the editor shows under its name field. */
const nameRefused = (status: 400 | 409, error: string): BranchListItemResponse => ({
  ok: false,
  status,
  error,
  code: 'BRANCH_NAME_REFUSED',
})

/** @internal Exported for tests. */
export const listBranchesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
): Promise<BranchListResponse> => {
  if (!ctx.services.registry) {
    return {
      ok: false,
      status: 400,
      error: 'Branch registry not initialized — ensure the workspace has been initialized',
    }
  }

  // A settings-branch workspace is never resolvable as a content branch (see
  // http/handler.ts), so one left on disk is hidden rather than listed unopenable.
  const settingsBranch = operatingStrategy(ctx.services.config.mode).getSettingsBranchName(
    ctx.services.config,
  )
  const allBranches = (await ctx.services.registry.list()).filter(
    (context) => !isSettingsBranchName(context.branch.name, settingsBranch),
  )

  // The branch the editor should open when none is pinned via URL/config: the name of the
  // workspace the active branch resolves to, which the editor finds in the list. Read
  // per-request so dev-mode refreshActiveBranch() updates are reflected.
  const activeBranch = ctx.services.config.defaultActiveBranch ?? baseBranchOf(ctx.services.config)
  const activeKey = sanitizeBranchName(activeBranch)
  const defaultBranch =
    allBranches.find((context) => path.basename(context.branchRoot) === activeKey)?.branch.name ??
    activeBranch

  // The access check is the rule: the list shows exactly the branches it grants, so the editor
  // never lists a branch it cannot open, nor leaves out one it can.
  const visibleBranches = allBranches.filter(
    (context) => ctx.services.checkBranchAccess(context, req.user).allowed,
  )

  return branchListResponse(ctx, req, visibleBranches, defaultBranch)
}

/**
 * The listing, with the profile of each listed branch's creator. Looked up only for branches the
 * requester may see, so it names no one they could not; the branch ACL's users stay behind the
 * privileged user lookup. A failed lookup costs the names, never the listing.
 */
const branchListResponse = async (
  ctx: ApiContext,
  req: ApiRequest,
  branches: readonly BranchContext[],
  defaultBranch: string,
): Promise<BranchListResponse> => {
  let users: UserProfile[] = []
  if (ctx.authPlugin) {
    try {
      users = await lookupUserProfiles(
        ctx.authPlugin,
        branches.map((context) => context.branch.createdBy),
      )
    } catch (error) {
      console.error('CanopyCMS: Failed to look up branch owners:', getErrorMessage(error))
    }
  }
  return {
    ok: true,
    status: 200,
    data: {
      branches: branches.map((context) =>
        toBranchListItem(ctx.services.config, context.branch, req.user),
      ),
      defaultBranch,
      users,
    },
  }
}

/** @internal Exported for tests. */
export const canDeleteBranch = (
  user: CanopyUser,
  branchContext: BranchContext,
): { allowed: boolean; reason: string } => {
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  if (branchContext.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

/** @internal Exported for tests. */
export const deleteBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
): Promise<BranchDeleteResponse> => {
  const branchName = params.branch

  // Disallow delete in modes that don't support branching (branch = developer's git checkout)
  const operatingMode = ctx.services.config.mode
  if (!clientOperatingStrategy(operatingMode).supportsBranching()) {
    return {
      ok: false,
      status: 400,
      error: 'Cannot delete branches in this operating mode',
    }
  }

  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Deleting the base branch would destroy the prod serving clone (and any
  // stranded edits on it) -- never valid, so this is checked before any
  // permission check below.
  const { isProtected } = getBranchProtection(
    ctx.services.config,
    branchContext.branch.name,
    branchContext.branch.baseBranch,
  )
  if (isProtected) {
    return { ok: false, status: 400, error: 'Cannot delete the base branch' }
  }

  const canDelete = canDeleteBranch(req.user, branchContext)
  if (!canDelete.allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to delete this branch',
    }
  }

  // Block deletion if branch has an open PR -- 'submitted' OR 'approved'.
  // 'approved' means a reviewer has already signed off and the PR is
  // awaiting merge: deleting here unlinks metadata, removes the clone, and
  // removes the branch head from the local mirror, leaving that reviewed PR
  // dangling on GitHub with no branch left to merge it from (mark-merged
  // becomes impossible) -- and with no signal back to the reviewer. Same
  // status code and message as the pre-existing 'submitted' refusal: the
  // isProtected refusal above this one already uses 400 where the
  // writableBranch/submittableBranch guards elsewhere use 403 for the same
  // "protected" category (tracked as a deferred, deliberately out-of-scope
  // cleanup in
  // safeinsights/canopycms#781); extending
  // this check to 'approved' keeps it consistent with its own immediate
  // neighbour rather than introducing a fresh 400/403 split between two
  // arms of the same guard.
  if (branchContext.branch.status === 'submitted' || branchContext.branch.status === 'approved') {
    return {
      ok: false,
      status: 400,
      error: 'Cannot delete branch with open pull request',
    }
  }

  // It may hold the only copy of commits the merge left out, and deleting it would drop the alert
  // that says so.
  if (branchContext.branch.unpublishedAtMerge && !isAdmin(req.user.groups)) {
    return {
      ok: false,
      status: 409,
      error:
        'This branch may hold changes that never reached GitHub. Ask an admin to check it before deleting it.',
    }
  }

  // The branch directory leaves its name by one rename, under the same
  // server-enforced lockfile branch-metadata saves hold (see
  // utils/occ-json-write.ts), so a save() that reaches that lock after the
  // rename fails rather than recreating the tree, and a process killed during
  // the `rm` leaves
  // only a `.deleting-*` directory the worker sweeps, never residue under a
  // name that may be created again.
  const metadataFile = path.join(branchContext.branchRoot, '.canopy-meta', 'branch.json')
  let cleanupWarning: string | undefined
  let deletingPath: string | undefined
  try {
    await withOccFileLock(metadataFile, async () => {
      if (branchContext.branchRoot === branchContext.baseRoot) {
        await fs.unlink(metadataFile).catch((err: unknown) => {
          if (!isNotFoundError(err)) throw err
        })
        return
      }
      const target = path.join(
        branchContext.baseRoot,
        deletingDirName(path.basename(branchContext.branchRoot)),
      )
      try {
        await fs.rename(branchContext.branchRoot, target)
        deletingPath = target
      } catch (err: unknown) {
        if (isNotFoundError(err)) return
        // Still deleted logically: without branch.json the branch is unlisted,
        // and the worker quarantines what is left.
        await fs.unlink(metadataFile).catch(() => {})
        // [REDACT] Returned to the browser; the console line keeps the path.
        cleanupWarning = `Failed to remove branch directory: ${sanitizeErrorMessage(getErrorMessage(err))}`
        console.error(
          `CanopyCMS: Failed to move branch directory for ${branchName} aside:`,
          getErrorMessage(err),
        )
      }
    })
  } catch (err: unknown) {
    // Lock acquisition failed (e.g. contention past the retry budget) —
    // surface as an error rather than silently skipping the delete.
    return {
      ok: false,
      status: 409,
      error: `Branch is busy, try again: ${getErrorMessage(err)}`,
    }
  }
  if (deletingPath) await removeLeftoverDir(deletingPath)

  // Also delete the branch's local head from the remote.git mirror (the
  // deployment's local origin). The sync loop's reconcileTrackedBranches
  // removes a head only once GitHub no longer has its branch, so while GitHub
  // does, THIS is the path that removes it -- without this, the head outlives
  // the branch, and reusing the name after the GitHub side is gone (e.g. a
  // squash-merged PR with auto-delete) has the reused branch's first publish
  // rejected non-fast-forward against the stale old tip: a permanent,
  // misleading 409 -- and a retried submit would then ship the STALE head to
  // GitHub as an apparent success (see GitManager.deleteBareRemoteHead's doc
  // comment for the full trace). The tracking ref is deliberately left
  // alone: while the branch still exists on GitHub, the create-time
  // collision check SHOULD keep matching it.
  //
  // Best-effort, same as the directory removal above: the branch is already
  // logically deleted; a mirror we can't reach/write just leaves today's
  // status quo behind (with a warning), it must not fail the delete.
  const strategy = operatingStrategy(operatingMode)
  const mirrorPath = resolveReadOnlyMirrorPath(ctx, strategy)
  const sanitizedDeleted = sanitizeBranchName(branchContext.branch.name)
  // Defense-in-depth only -- isProtected above already rejects the base
  // branch, and settings branches never resolve through getBranchContext.
  const sanitizedBase = sanitizeBranchName(
    branchContext.branch.baseBranch ?? baseBranchOf(ctx.services.config),
  )
  const deletableHead =
    sanitizedDeleted !== sanitizedBase &&
    !sanitizedDeleted.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
  if (
    deletableHead &&
    mirrorPath &&
    !isNetworkRemoteUrl(mirrorPath) &&
    (await filePathExists(mirrorPath))
  ) {
    try {
      await GitManager.deleteBareRemoteHead(mirrorPath, branchContext.branch.name)
    } catch (err: unknown) {
      // Client-facing copy is sanitized (API-H2 — no absolute EFS paths);
      // the console line keeps the raw detail for server logs.
      const warning = `Failed to remove the deleted branch's head from the local mirror: ${sanitizeErrorMessage(getErrorMessage(err))}`
      cleanupWarning = cleanupWarning ? `${cleanupWarning}; ${warning}` : warning
      console.warn(
        `CanopyCMS: failed to remove deleted branch's mirror head (branch ${branchContext.branch.name}, mirror ${mirrorPath}): ${getErrorMessage(err)}`,
      )
    }
  }

  // `branchContext` was read before the delete, so it still carries the PR number this gates on.
  if (deletableHead) {
    const warning = await syncDeleteRemoteBranch(ctx, branchContext)
    if (warning) cleanupWarning = cleanupWarning ? `${cleanupWarning}; ${warning}` : warning
  }

  // Invalidate registry cache so next list() will regenerate without this branch
  if (!ctx.services.registry) {
    return {
      ok: false,
      status: 400,
      error: 'Branch registry not initialized — ensure the workspace has been initialized',
    }
  }
  await ctx.services.registry.invalidate()

  return {
    ok: true,
    status: 200,
    data: { deleted: true, ...(cleanupWarning && { cleanupWarning }) },
  }
}

export interface UpdateBranchAccessBody {
  allowedUsers?: string[]
  allowedGroups?: string[]
}

/** @internal Exported for tests. */
export const canModifyBranchAccess = (
  user: CanopyUser,
  branchContext: BranchContext,
): { allowed: boolean; reason: string } => {
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  if (branchContext.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

/** @internal Exported for tests. */
export const updateBranchAccessHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof updateBranchAccessBodySchema>,
): Promise<BranchListItemResponse> => {
  const branchName = params.branch

  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // The protected base branch takes no ACL. Its content is read-only in prod and
  // submit/delete are already blocked, but a base-branch ACL entry still feeds
  // canPerformWorkflowAction's `allowed_by_acl` grant -- so writing one here
  // would hand arbitrary users Withdraw rights on the base branch. Reject
  // outright, consistent with the delete and submit rails.
  const { isProtected } = getBranchProtection(
    ctx.services.config,
    branchContext.branch.name,
    branchContext.branch.baseBranch,
  )
  if (isProtected) {
    return {
      ok: false,
      status: 403,
      error: 'The base branch does not take an access list. Create a branch to manage access.',
    }
  }

  const canModify = canModifyBranchAccess(req.user, branchContext)
  if (!canModify.allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to modify this branch',
    }
  }

  // Build the access DELTA from only the keys the caller actually supplied —
  // never spread branchContext.branch.access (a snapshot resolved before
  // this handler acquired anything) wholesale. save()'s field-level merge
  // (branch-metadata.ts) takes the incoming access object's keys over the
  // freshly-reloaded on-disk ones, so a full stale spread here would
  // silently revert any key a concurrent request changed via the OTHER key
  // in the gap between this handler's getBranchContext() and its save()
  // call. An omitted key must be ABSENT from this object (not merely
  // undefined-valued) so save()'s spread-merge leaves the on-disk value
  // untouched; a supplied `[]` still comes through and clears the field.
  const newAccess: BranchAccessControl = {}
  if (body.allowedUsers !== undefined) {
    newAccess.allowedUsers = body.allowedUsers
  }
  if (body.allowedGroups !== undefined) {
    newAccess.allowedGroups = body.allowedGroups
  }

  // Update metadata (automatically invalidates registry cache)
  const metadata = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  const updated = await metadata.save({
    branch: { access: newAccess },
  })

  return {
    ok: true,
    status: 200,
    data: { branch: toBranchListItem(ctx.services.config, updated.branch, req.user) },
  }
}

/**
 * List all branches visible to current user
 */
const listBranches = defineEndpoint({
  namespace: 'branches',
  name: 'list',
  method: 'GET',
  path: '/branches',
  responseType: 'BranchListResponse',
  response: {} as BranchListResponse,
  defaultMockData: { branches: [], users: [] },
  handler: listBranchesHandler,
})

const createBranch = defineEndpoint({
  namespace: 'branches',
  name: 'create',
  clientTimeout: 'long',
  method: 'POST',
  path: '/branches',
  body: createBranchBodySchema,
  bodyType: 'CreateBranchBody',
  responseType: 'BranchListItemResponse',
  response: {} as BranchListItemResponse,
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  handler: createBranchHandler,
})

const deleteBranch = defineEndpoint({
  namespace: 'branches',
  name: 'delete',
  method: 'DELETE',
  path: '/:branch',
  params: branchParamSchema,
  responseType: 'BranchDeleteResponse',
  response: {} as BranchDeleteResponse,
  defaultMockData: { deleted: true },
  handler: deleteBranchHandler,
})

/**
 * No 'writableBranch' guard: this rewrites branch.json's ACL, not branch
 * content, so a submitted branch's ACL stays editable during review. The base
 * branch is a different matter and IS refused -- the handler rejects protected
 * branches up front, because a base-branch ACL entry feeds
 * canPerformWorkflowAction's `allowed_by_acl` grant and would confer Withdraw
 * rights there.
 */
const updateBranchAccess = defineEndpoint({
  namespace: 'branches',
  name: 'updateAccess',
  method: 'PATCH',
  path: '/:branch/access',
  params: branchParamSchema,
  body: updateBranchAccessBodySchema,
  bodyType: 'UpdateBranchAccessBody',
  responseType: 'BranchListItemResponse',
  response: {} as BranchListItemResponse,
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  handler: updateBranchAccessHandler,
})

export const BRANCH_ROUTES = {
  list: listBranches,
  create: createBranch,
  delete: deleteBranch,
  updateAccess: updateBranchAccess,
} as const
