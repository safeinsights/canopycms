import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { BranchAccessControl, BranchContext, BranchMetadata } from '../types'
import { BranchWorkspaceManager } from '../branch-workspace'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withOccFileLock } from '../utils/occ-json-write'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { createDebugLogger } from '../utils/debug'
import { clientOperatingStrategy } from '../operating-mode'
import { isNotFoundError, getErrorMessage } from '../utils/error'
import { filePathExists } from '../utils/fs'
import { isNetworkRemoteUrl } from '../utils/git'
import { sanitizeBranchName, RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths'
import { GitManager } from '../git-manager'
import { branchNameSchema, branchParamSchema } from './validators'

const log = createDebugLogger({ prefix: 'BranchAPI' })

/** Response type for single branch operations (create, update, status) */
export type BranchResponse = ApiResponse<{ branch: BranchMetadata }>

/**
 * A listed branch plus server-computed protected-base-branch flags (see
 * authorization/protected-branch.ts). Optional on the wire, matching the
 * `defaultBranch` precedent, so older clients/servers stay compatible; this
 * server always emits both.
 */
export interface BranchListItem extends BranchMetadata {
  isProtected?: boolean
  readOnly?: boolean
}

/** Response type for listing branches */
export type BranchListResponse = ApiResponse<{
  branches: BranchListItem[]
  /**
   * The server's effective default branch (the detected active branch in dev
   * mode). Clients without an explicitly pinned branch should open this one.
   * Optional on the wire so older servers remain compatible.
   */
  defaultBranch?: string
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

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

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

import { isPrivileged, isAdmin, loadPathPermissions, getBranchProtection } from '../authorization'
import type { PathPermission } from '../config'
import type { CanopyUser } from '../user'
import { operatingStrategy } from '../operating-mode'

/**
 * Check if a user can create branches.
 * Returns true if:
 * - User is Admin or Reviewer (privileged)
 * - User has edit access to at least one path via pathPermissions rules
 * - No path permissions are defined (open access)
 */
export const canCreateBranch = (
  user: CanopyUser,
  pathPermissions: PathPermission[],
): { allowed: boolean; reason: string } => {
  // Admins and Reviewers can always create branches
  if (isPrivileged(user.groups)) {
    return { allowed: true, reason: 'privileged_user' }
  }

  // If no path permissions defined, anyone can create branches
  if (pathPermissions.length === 0) {
    return { allowed: true, reason: 'no_restrictions' }
  }

  // Check if user has edit access to at least one path rule
  for (const rule of pathPermissions) {
    const editTarget = rule.edit
    if (!editTarget) continue

    // Check if rule has no user/group constraints (open to all)
    const hasUserConstraint = !!editTarget.allowedUsers?.length
    const hasGroupConstraint = !!editTarget.allowedGroups?.length
    if (!hasUserConstraint && !hasGroupConstraint) {
      return { allowed: true, reason: 'open_path_rule' }
    }

    // Check if user matches the rule
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

export const createBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof createBranchBodySchema>,
): Promise<BranchResponse> => {
  return log.timed('api', 'createBranch', async () => {
    const branchName = body.branch
    log.debug('api', 'Create branch request', {
      branchName,
      userId: req.user.userId,
    })

    // Scope note: the collision guards below (settings-branch collision,
    // reserved canopycms-settings- prefix, and the remote-mirror check
    // further down) apply ONLY to this user-facing creation path.
    // http/handler.ts's auto-create (base/active/settings branches) and
    // branch-workspace.ts's loadOrCreateBranchContext (reached from content
    // reads and the AI pipeline) provision system/known branch names, not
    // user-chosen ones, and deliberately stay uncovered -- intentional, not
    // an oversight.

    // Prevent git branch name collision with the settings branch. Settings
    // live in a separate directory but share the same git remote, and
    // openOrCreateBranch (branch-workspace.ts) uses the SANITIZED name as the
    // actual git branch name. parseBranchName (via branchNameSchema) permits
    // '/', so a raw-string comparison here let a request for
    // "canopycms/settings-prod" sail past this check while
    // sanitizeBranchName() collapsed it to "canopycms-settings-prod" --
    // creating a content branch whose real git ref WAS the settings branch.
    // Comparing sanitized forms on both sides closes that bypass.
    const strategy = operatingStrategy(ctx.services.config.mode)
    const sanitizedRequested = sanitizeBranchName(branchName)
    if (strategy.usesSeparateSettingsBranch()) {
      const settingsBranchName = strategy.getSettingsBranchName(ctx.services.config)
      if (sanitizedRequested === sanitizeBranchName(settingsBranchName)) {
        return {
          ok: false,
          status: 400,
          error:
            'Cannot create content branch with settings branch name (git branch name collision)',
        }
      }
    }

    // Reserve the WHOLE canopycms-settings- namespace, not just this
    // deployment's own settings branch name. Two CanopyCMS deployments can
    // share one GitHub repo, each with its own settings branch under this
    // prefix; the worker (worker/cms-worker.ts) treats any
    // `canopycms-settings-*` ref specially (orphan-branch reconcile/push
    // logic), so another deployment's settings branch is a real name that
    // must not be claimable as a content branch here either.
    if (sanitizedRequested.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)) {
      return {
        ok: false,
        status: 400,
        error: `Branch names starting with "${RESERVED_SETTINGS_BRANCH_PREFIX}" are reserved for CanopyCMS settings branches`,
      }
    }

    // Reject the base branch name outright. openOrCreateBranch's save() (see
    // branch-metadata.ts) field-merges the caller-supplied `access` over an
    // EXISTING branch's metadata rather than replacing it, so a request
    // naming the base branch would let the caller inject themselves into the
    // protected base branch's ACL (gaining e.g. withdraw rights via the
    // allowed_by_acl path). No recorded fork point exists yet for a
    // not-yet-created branch, so this checks config protection only.
    const { isProtected } = getBranchProtection(ctx.services.config, branchName)
    if (isProtected) {
      return {
        ok: false,
        status: 400,
        error: 'Cannot create a branch with the base branch name',
      }
    }

    // Reject a name collision with ANY existing branch for the same
    // field-merge reason: creating over an existing branch name would let
    // the caller's `access` ACL overwrite that branch's real ACL instead of
    // creating a new, separate branch. Comparison uses the sanitized name
    // since that's what's persisted in branch.json (see
    // BranchWorkspaceManager.openOrCreateBranch). System branches
    // auto-provisioned via http/handler.ts's getBranchContext don't go
    // through this handler, so rejecting collisions here doesn't affect them.
    if (!ctx.services.registry) {
      return {
        ok: false,
        status: 400,
        error: 'Branch registry not initialized — ensure the workspace has been initialized',
      }
    }
    const existingBranch = await ctx.services.registry.get(sanitizeBranchName(branchName))
    if (existingBranch) {
      return {
        ok: false,
        status: 409,
        error: 'A branch with this name already exists',
      }
    }

    // L2: create-time collision check against this deployment's local
    // GitHub mirror (`remote.git`). The CMS Lambda has no internet access
    // (PRIVATE_ISOLATED subnets, no NAT -- see AGENTS.md), so a synchronous
    // GitHub API call at branch-create time is not possible. But remote.git
    // is BOTH this deployment's local git origin AND a mirror of GitHub's
    // view of the repo: cms-worker.ts's syncGit() fetches GitHub into it
    // (see GITHUB_TRACKING_REF_PREFIX's doc comment in git-manager.ts) and
    // then reconciles refs/heads/* non-destructively, so it carries both
    // this deployment's local heads and GitHub's view -- readable offline by
    // this same Lambda, since it resolves to the same EFS inode the worker
    // uses. Reading it here catches a sanitized-name collision with a branch
    // another CanopyCMS deployment sharing this repo (or a direct push to
    // GitHub) already created -- something the local registry check above
    // cannot see.
    //
    // Resolving remote.git's path must not have side effects:
    // GitManager.resolveRemoteUrl is NOT safe to call here -- in dev mode its
    // shouldAutoInitLocal branch CREATES a simulated remote as a side effect
    // of merely asking where one would be. So this resolves read-only,
    // mirroring resolveRemoteUrl's own precedence for its first three
    // sources only (config.defaultRemoteUrl -> env var -> the strategy's
    // auto-detect path); resolveRemoteUrl's fourth source (auto-init) is
    // exactly the side effect being avoided, so it has no read-only
    // equivalent here.
    const remoteUrlConfig = strategy.getRemoteUrlConfig()
    const resolvedMirrorPath: string | undefined =
      ctx.services.config.defaultRemoteUrl ??
      process.env[remoteUrlConfig.envVarName] ??
      remoteUrlConfig.autoDetectRemotePath

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
        const collision = await GitManager.bareRemoteHasBranch(
          resolvedMirrorPath,
          sanitizedRequested,
          // GitHub's view only -- see bareRemoteHasBranch. A local head in
          // remote.git survives an editor-side branch delete forever, so
          // including refs/heads/* here would make the ordinary create ->
          // publish -> merge -> delete -> reuse cycle 409 permanently on a name
          // the user just deleted. Locally-live branches are already rejected
          // by the registry check above.
          { namespaces: 'tracking' },
        )
        if (collision) {
          return {
            ok: false,
            status: 409,
            error:
              `A branch named "${sanitizedRequested}" already exists on the remote. ` +
              `It may have been created by another CanopyCMS deployment sharing this ` +
              `repository, pushed directly to GitHub, or left behind by an earlier branch ` +
              `of the same name. Choose a different name.`,
          }
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
    const baseBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const baseBranchContext = await ctx.getBranchContext(baseBranch)

    let pathPermissions: PathPermission[] = []
    if (baseBranchContext) {
      const operatingMode = ctx.services.config.mode
      pathPermissions = await loadPathPermissions(baseBranchContext.branchRoot, operatingMode)
    }

    // Check if user can create branches
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
    const operatingMode = ctx.services.config.mode
    const context = await manager.openOrCreateBranch({
      branchName,
      mode: operatingMode,
      createdBy: req.user.userId,
      title: body.title,
      description: body.description,
      access: body.access,
    })

    log.debug('api', 'Branch created', { branchName: context.branch.name })
    return { ok: true, status: 200, data: { branch: context.branch } }
  })
}

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

  const allBranches = await ctx.services.registry.list()

  // The branch the editor should open when none is pinned via URL/config.
  // Read per-request so dev-mode refreshActiveBranch() updates are reflected.
  // Sanitized: dev mode detects the RAW git HEAD name (e.g. 'claude/foo'),
  // but registry branch names are filesystem-sanitized ('claude-foo') — the
  // editor matches defaultBranch against registry names, so return the form
  // that can actually be found there.
  const defaultBranch = sanitizeBranchName(
    ctx.services.config.defaultActiveBranch ?? ctx.services.config.defaultBaseBranch ?? 'main',
  )

  // Attach server-computed protected-base-branch flags; read config per-request
  // so dev-mode refreshActiveBranch() updates are reflected here too.
  const toListItem = (context: BranchContext): BranchListItem => {
    const protection = getBranchProtection(
      ctx.services.config,
      context.branch.name,
      context.branch.baseBranch,
    )
    return { ...context.branch, isProtected: protection.isProtected, readOnly: protection.readOnly }
  }

  // Admins and Reviewers see all branches
  if (isPrivileged(req.user.groups)) {
    return {
      ok: true,
      status: 200,
      data: { branches: allBranches.map(toListItem), defaultBranch },
    }
  }

  // Regular users only see branches they created or have explicit access to
  const visibleBranches = allBranches.filter((context) => {
    const branch = context.branch
    // The protected base branch is where every user lands by default; always
    // show it (read-only) so the editor can render its protected state.
    if (getBranchProtection(ctx.services.config, branch.name, branch.baseBranch).isProtected) {
      return true
    }
    // User created the branch
    if (branch.createdBy === req.user.userId) {
      return true
    }
    // User is in allowedUsers
    if (branch.access?.allowedUsers?.includes(req.user.userId)) {
      return true
    }
    // User's group is in allowedGroups
    if (
      branch.access?.allowedGroups?.some((groupId) =>
        (req.user.groups as readonly string[])?.includes(groupId),
      )
    ) {
      return true
    }
    return false
  })

  return {
    ok: true,
    status: 200,
    data: { branches: visibleBranches.map(toListItem), defaultBranch },
  }
}

/**
 * Check if a user can delete a specific branch.
 * Returns true if user is Admin or the branch creator.
 */
export const canDeleteBranch = (
  user: CanopyUser,
  branchContext: BranchContext,
): { allowed: boolean; reason: string } => {
  // Admins can delete any branch
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  // Branch creator can delete their own branch
  if (branchContext.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

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

  // Get branch context
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

  // Check permission
  const canDelete = canDeleteBranch(req.user, branchContext)
  if (!canDelete.allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to delete this branch',
    }
  }

  // Block deletion if branch has open PR (submitted status)
  if (branchContext.branch.status === 'submitted') {
    return {
      ok: false,
      status: 400,
      error: 'Cannot delete branch with open pull request',
    }
  }

  // Delete branch metadata file so it disappears from registry scans.
  // Hold the same server-enforced lockfile branch-metadata saves hold
  // (see utils/occ-json-write.ts): an unguarded unlink racing a concurrent
  // save() would let the save's create path resurrect a phantom branch.json
  // inside a deleted branch, which the registry's next scan would list as a
  // live branch with no clone. The directory removal happens inside the
  // same hold so a racing save cannot slip between unlink and rm either.
  const metadataFile = path.join(branchContext.branchRoot, '.canopy-meta', 'branch.json')
  let cleanupWarning: string | undefined
  try {
    await withOccFileLock(metadataFile, async () => {
      try {
        await fs.unlink(metadataFile)
      } catch (err: unknown) {
        if (!isNotFoundError(err)) {
          console.error(
            `CanopyCMS: Failed to delete branch metadata for ${branchName}:`,
            getErrorMessage(err),
          )
        }
      }

      // In multi-branch modes, also delete the entire branch directory.
      // Retry transient EFS/NFS errors (ENOTEMPTY from a concurrent writer,
      // EBUSY) a few times before giving up -- rm's failure must never be
      // swallowed: metadata is gone either way (the branch is logically
      // deleted and will no longer appear in listings), but silently
      // succeeding here would leave a full orphan clone on disk with
      // nothing in the API surfacing its existence.
      if (branchContext.branchRoot !== branchContext.baseRoot) {
        try {
          await fs.rm(branchContext.branchRoot, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          })
        } catch (err: unknown) {
          cleanupWarning = `Failed to fully remove branch directory: ${getErrorMessage(err)}`
          console.error(
            `CanopyCMS: Failed to delete branch directory for ${branchName}:`,
            getErrorMessage(err),
          )
        }
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

/**
 * Check if a user can modify branch access.
 * Returns true if user is Admin or the branch creator.
 */
export const canModifyBranchAccess = (
  user: CanopyUser,
  branchContext: BranchContext,
): { allowed: boolean; reason: string } => {
  // Admins can modify any branch
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  // Branch creator can modify their own branch
  if (branchContext.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

export const updateBranchAccessHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof updateBranchAccessBodySchema>,
): Promise<BranchResponse> => {
  const branchName = params.branch

  // Get branch context
  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
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

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * List all branches visible to current user
 * GET /branches
 */
const listBranches = defineEndpoint({
  namespace: 'branches',
  name: 'list',
  method: 'GET',
  path: '/branches',
  responseType: 'BranchListResponse',
  response: {} as BranchListResponse,
  defaultMockData: { branches: [] },
  handler: listBranchesHandler,
})

/**
 * Create a new branch
 * POST /branches
 */
const createBranch = defineEndpoint({
  namespace: 'branches',
  name: 'create',
  method: 'POST',
  path: '/branches',
  body: createBranchBodySchema,
  bodyType: 'CreateBranchBody',
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
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

/**
 * Delete a branch
 * DELETE /:branch
 */
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
 * Update branch access control
 * PATCH /:branch/access
 *
 * No 'writableBranch' guard: this only rewrites branch.json's ACL, not branch
 * content, so it's out of scope for this pass. Noted as a future tightening
 * candidate -- letting non-admins edit the base branch's ACL is questionable
 * but pre-existing behavior this plan doesn't change.
 */
const updateBranchAccess = defineEndpoint({
  namespace: 'branches',
  name: 'updateAccess',
  method: 'PATCH',
  path: '/:branch/access',
  params: branchParamSchema,
  body: updateBranchAccessBodySchema,
  bodyType: 'UpdateBranchAccessBody',
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
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

/**
 * Exported routes for router registration
 */
export const BRANCH_ROUTES = {
  list: listBranches,
  create: createBranch,
  delete: deleteBranch,
  updateAccess: updateBranchAccess,
} as const
