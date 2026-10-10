/**
 * `CanopyServices` — the long-lived, per-deployment service container, built
 * once by `createCanopyServices` and threaded through `ApiContext.services` to
 * every API handler. Holds config, the schema registry and cache, the ACL
 * checkers, the git-manager factory, the branch registry, the GitHub service,
 * and four branch-workflow operations. Not `context.ts`, which is the
 * per-REQUEST facade built on top of this.
 *
 * SCOPE WARNING: a service locator every api module reaches, so adding a field
 * is free and therefore constant, and no handler's signature reveals what it
 * touches. Give a new capability its own narrow interface instead.
 *
 * `createTestCanopyServices` is test-only despite living in a production
 * module; it reaches the published surface through a wildcard re-export.
 *
 * Module map: ./AGENTS.md.
 */
import type { CanopyConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'
import { getConfigDefaults } from './config'
import type { BranchContext, BranchMetadata, BranchPaths } from './types'
import type { CanopyUser } from './user'
import {
  createCheckBranchAccess,
  createCheckContentAccess,
  createContentAccessChecker,
  loadPathPermissions,
  type ContentAccessChecker,
} from './authorization'
import { GitManager, GitRemoteRefMissingError } from './git-manager'
import { BranchRegistry } from './branch-registry'
import { SettingsWorkspaceManager } from './settings-workspace'
import { getDefaultBranchBase, sanitizeBranchName } from './paths'
import { createGitHubService, type GitHubService } from './github-service'
import { operatingStrategy } from './operating-mode'
import { BranchSchemaCache } from './branch-schema-cache'
import { enqueueTask } from './task-queue/cms-task-queue'
import { getTaskQueueDir } from './task-queue/task-queue-config'
import { detectHeadBranch, isCanopyInternalPath } from './utils/git'
import { readsFromCheckout } from './build-mode'
import { timeRequestPhase } from './utils/request-timing'
import {
  appendTrailers,
  buildEditorTrailers,
  describeEditors,
  type EditorLookup,
  type SubmissionEditor,
} from './submission-attribution'
import { getBranchMetadataFileManager, recordBranchEditor } from './branch-metadata'
import { readBranchMetadataFile } from './branch-metadata-file'
import { getErrorMessage, redactCredentials } from './utils/error'
import { withContentWriteLock } from './utils/content-write-lock'

/**
 * A per-instance active-branch detector with its own 5s TTL cache, in priority
 * order: an explicitly configured value; `defaultBaseBranch ?? 'main'` with no
 * git for static deployments and builds; git HEAD in dev; and
 * `defaultBaseBranch ?? 'main'` in prod.
 */
function createActiveBranchDetector() {
  let cache: { value: string; expiresAt: number } | null = null

  return async (config: CanopyConfig): Promise<string> => {
    if (config.defaultActiveBranch) return config.defaultActiveBranch
    // Static deployments and builds read content from the checkout — never shell out to git
    if (readsFromCheckout(config)) return config.defaultBaseBranch ?? 'main'
    if (config.mode === 'dev') {
      const now = Date.now()
      if (cache && now < cache.expiresAt) {
        return cache.value
      }
      // Detect from cwd, never sourceRoot: git walks up to find .git, and
      // sourceRoot locates content, not the repo root. On a detached HEAD or
      // outside a repo, detectHeadBranch falls back instead of throwing.
      const branch = await detectHeadBranch(process.cwd(), config.defaultBaseBranch ?? 'main')
      cache = { value: branch, expiresAt: now + 5000 }
      return branch
    }
    return config.defaultBaseBranch ?? 'main'
  }
}

/**
 * Bootstrap admin IDs from the environment. These users are treated as Admins
 * whatever their group membership.
 */
export const getBootstrapAdminIds = (): Set<string> => {
  const envVar = process.env.CANOPY_BOOTSTRAP_ADMIN_IDS
  if (!envVar) return new Set()
  return new Set(
    envVar
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
}

/**
 * Submit found nothing to send: the branch's saved content, committed or not, matches its base
 * as of the fork point. Raised before anything is pushed and after undoing any commit the
 * submit made, so the branch's commits and saved edits are as they were.
 */
export class NothingToSubmitError extends Error {
  constructor(branch: string, base: string) {
    super(
      `Nothing to submit yet: "${branch}" has no saved changes compared with "${base}". ` +
        'Save your edits, then submit.',
    )
    this.name = 'NothingToSubmitError'
  }
}

type RecordedEditors = Pick<BranchMetadata, 'editors' | 'uncommittedEditors'>

/** The branch's recorded editor ids, or undefined, with a warning, when branch.json cannot be read. */
async function readRecordedEditors(context: BranchContext): Promise<RecordedEditors | undefined> {
  try {
    return (await readBranchMetadataFile(context.branchRoot))?.branch
  } catch (err) {
    console.warn(
      `CanopyCMS: Could not read the recorded editors of ${context.branch.name}:`,
      getErrorMessage(err),
    )
    return undefined
  }
}

/** One lookup per user per submit, however often the submit asks. */
function memoizeLookup(lookup: EditorLookup | undefined): EditorLookup | undefined {
  if (!lookup) return undefined
  const seen = new Map<string, ReturnType<EditorLookup>>()
  return (userId) => {
    let found = seen.get(userId)
    if (!found) {
      found = lookup(userId)
      seen.set(userId, found)
    }
    return found
  }
}

export interface SubmitBranchResult {
  /** Repo-relative paths the branch changes, excluding canopycms runtime metadata. */
  changedPaths: string[]
  /** Every recorded editor of the branch, for the PR body. */
  editors: SubmissionEditor[]
}

export interface CanopyServices {
  config: CanopyConfig
  /**
   * Re-detect the active branch from git HEAD (dev mode only, cached 5s).
   * Silently updates config if the branch changed — only affects non-editor
   * content serving since the editor is pinned to its own branch via URL params.
   */
  refreshActiveBranch: () => Promise<void>
  /** Entry schema registry mapping entry schema names to field definitions */
  entrySchemaRegistry: EntrySchemaRegistry
  /** Per-branch schema cache */
  branchSchemaCache: import('./branch-schema-cache').BranchSchemaCache
  checkBranchAccess: (
    context: BranchContext,
    user: CanopyUser,
  ) => ReturnType<ReturnType<typeof createCheckBranchAccess>>
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  /**
   * A batch content-access checker: loads permissions once, returns a
   * synchronous per-path check. Use it whenever one request checks many paths,
   * so permissions are not re-loaded per path.
   */
  createContentAccessChecker: (
    context: BranchContext,
    branchRoot: string,
    user: CanopyUser,
  ) => Promise<ContentAccessChecker>
  createGitManagerFor: (
    repoPath: string,
    opts?: { baseBranch?: string; remote?: string; skipIndexMarker?: boolean },
  ) => GitManager
  registry?: BranchRegistry
  githubService?: GitHubService
  /** Bootstrap admin user IDs that are always treated as Admins */
  bootstrapAdminIds: Set<string>
  /**
   * Commit files to git with automatic author handling. Holds the branch's
   * content-write lock; rejects with `ContentWriteLockBusyError` when busy.
   */
  commitFiles: (options: {
    context: BranchContext
    files: string | string[]
    message: string
  }) => Promise<void>
  /**
   * Submit branch: commit all changes (with the submitter's trailers) and push
   * to remote. Resolves with every path the branch changes against its base.
   * Holds the branch's content-write lock; rejects with
   * `ContentWriteLockBusyError` when busy, and with `NothingToSubmitError`
   * before pushing when the branch changes nothing.
   */
  submitBranch: (options: {
    context: BranchContext
    submitter?: SubmissionEditor
    /** Names the recorded editors; without it they are credited by id. */
    lookupEditor?: EditorLookup
    message?: string
  }) => Promise<SubmitBranchResult>
  /** Commit to the settings branch (for permissions/groups) and push it; never opens a PR */
  commitToSettingsBranch: (options: {
    branchRoot: string
    files: string | string[]
    message: string
  }) => Promise<{
    committed: boolean
    pushed: boolean
    error?: string
    syncStatus?: 'pending-sync' | 'synced' | 'sync-failed'
  }>
  /** Get the root path for settings storage (ensures workspace exists) */
  getSettingsBranchRoot: () => Promise<string>
  /** Records `user` as an editor of the branch for its next submit (branch-metadata.ts). */
  recordBranchEditor: (context: BranchPaths, user: CanopyUser) => Promise<void>
}

export interface CreateCanopyServicesOptions {
  /** Entry schema names → field definitions, for resolving .collection.json references. */
  entrySchemaRegistry?: EntrySchemaRegistry
  /**
   * Test-only: bypasses the default BranchSchemaCache creation.
   * @internal
   */
  branchSchemaCache?: BranchSchemaCache
  /**
   * Test-only: bypasses the real git workspace setup for settings.
   * @internal
   */
  getSettingsBranchRoot?: () => Promise<string>
}

/**
 * Build the reusable helpers from a validated CanopyConfig — once at startup,
 * then injected into request handlers and loaders. Schema is not loaded here;
 * BranchSchemaCache loads it per branch.
 */
export const createCanopyServices = async (
  config: CanopyConfig,
  options: CreateCanopyServicesOptions = {},
): Promise<CanopyServices> => {
  return _createCanopyServicesInternal(config, options)
}

/** {@link createCanopyServices} for tests, with branch identity pinned. */
export const createTestCanopyServices = async (
  config: CanopyConfig,
  options: CreateCanopyServicesOptions = {},
): Promise<CanopyServices> => {
  // Pin both branch identity fields rather than auto-detect from git HEAD,
  // which varies with the developer's working branch.
  const testConfig = {
    ...config,
    defaultBaseBranch: config.defaultBaseBranch ?? 'main',
    defaultActiveBranch: config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main',
  }
  return _createCanopyServicesInternal(testConfig, options)
}

/** Shared implementation; call createCanopyServices or createTestCanopyServices. */
async function _createCanopyServicesInternal(
  config: CanopyConfig,
  options: CreateCanopyServicesOptions,
): Promise<CanopyServices> {
  // Mode-specific requirements, e.g. prod's git bot credentials for GitHub.
  const strategy = operatingStrategy(config.mode)
  strategy.validateConfig(config)

  // Resolve branch identity once and bake both into config, so downstream code
  // reads one consistent value (see ARCHITECTURE.md "Branch Identity"): the
  // active branch is the workspace to serve from, the base branch the fork
  // point for new editing branches.
  const detectActiveBranch = createActiveBranchDetector()
  const explicitActiveBranch = config.defaultActiveBranch
  const explicitBaseBranch = config.defaultBaseBranch
  const defaultActiveBranch = await detectActiveBranch(config)
  // Unset, the base branch follows the same dev-mode HEAD detection, matching
  // resolveBaseBranch in utils/git.ts — the canonical definition workspace
  // provisioning uses.
  const defaultBaseBranch =
    explicitBaseBranch ??
    (config.mode === 'dev' && !readsFromCheckout(config)
      ? await detectActiveBranch({ ...config, defaultActiveBranch: undefined })
      : 'main')
  config = { ...config, defaultActiveBranch, defaultBaseBranch }

  const bootstrapAdminIds = getBootstrapAdminIds()

  const branchSchemaCache = options.branchSchemaCache ?? new BranchSchemaCache(config.mode)

  const checkBranchAccess = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny', config)
  // Content access loads permissions dynamically from the settings branch (orphan git branch)
  const ensureSettingsBranchRoot =
    options.getSettingsBranchRoot ??
    (async (): Promise<string> => {
      const strategy = operatingStrategy(config.mode)

      const settingsRoot = strategy.getSettingsRoot()
      const branchName = strategy.getSettingsBranchName(config)

      const manager = new SettingsWorkspaceManager(config)
      await manager.ensureGitWorkspace({
        settingsRoot,
        branchName,
        mode: config.mode,
        remoteUrl: config.defaultRemoteUrl,
      })

      return settingsRoot
    })
  const getSettingsBranchRoot = () => timeRequestPhase('settingsRoot', ensureSettingsBranchRoot)

  const contentAccessDeps = {
    checkBranchAccess,
    loadPathPermissions: (repoRoot: string, mode: CanopyConfig['mode']) =>
      timeRequestPhase('permissions', () => loadPathPermissions(repoRoot, mode)),
    defaultPathAccess: config.defaultPathAccess ?? 'deny',
    mode: config.mode,
    getSettingsBranchRoot,
  }
  const checkContentAccess = createCheckContentAccess(contentAccessDeps)
  const createContentAccessCheckerBound = (
    context: BranchContext,
    branchRoot: string,
    user: CanopyUser,
  ): Promise<ContentAccessChecker> =>
    createContentAccessChecker(contentAccessDeps, context, branchRoot, user)
  const configDefaults = getConfigDefaults()
  const createGitManagerFor = (
    repoPath: string,
    opts?: { baseBranch?: string; remote?: string; skipIndexMarker?: boolean },
  ) =>
    new GitManager({
      repoPath,
      baseBranch: opts?.baseBranch ?? config.defaultBaseBranch ?? 'main',
      remote: opts?.remote ?? config.defaultRemoteName ?? configDefaults.remoteName,
      skipIndexMarker: opts?.skipIndexMarker,
    })

  const commitFiles = async (options: {
    context: BranchContext
    files: string | string[]
    message: string
  }): Promise<void> => {
    // Prefer the fork point recorded at branch creation over the (possibly
    // re-detected) config value, so operations stay pinned to the branch's base.
    const git = createGitManagerFor(options.context.branchRoot, {
      baseBranch: options.context.branch.baseBranch,
    })
    await git.ensureAuthor({
      name: config.gitBotAuthorName,
      email: config.gitBotAuthorEmail,
    })
    // [SYNC-C1] Unlocked, a commit made while a rebase is stopped on a conflict
    // lands on its detached head with the rebase's half-resolved index, and the
    // rebase's `--abort` discards it.
    await withContentWriteLock(options.context.branchRoot, async () => {
      await git.add(options.files)
      await git.commit(options.message)
    })
  }

  const submitBranch = async (options: {
    context: BranchContext
    submitter?: SubmissionEditor
    lookupEditor?: EditorLookup
    message?: string
  }): Promise<SubmitBranchResult> => {
    // Defense-in-depth: refuse to push the base branch to itself even if the
    // 'submittableBranch' guard was somehow bypassed. Prefer the recorded fork
    // point (context.branch.baseBranch) over config.defaultBaseBranch — the
    // closure-captured `config` can go stale after dev refreshActiveBranch().
    const effectiveBase = options.context.branch.baseBranch ?? config.defaultBaseBranch ?? 'main'
    if (sanitizeBranchName(options.context.branch.name) === sanitizeBranchName(effectiveBase)) {
      throw new Error(
        `Refusing to commit and push the base branch "${options.context.branch.name}" — submitting requires a separate editing branch`,
      )
    }

    const git = createGitManagerFor(options.context.branchRoot, {
      baseBranch: options.context.branch.baseBranch,
    })
    await git.ensureAuthor({
      name: config.gitBotAuthorName,
      email: config.gitBotAuthorEmail,
    })
    // [SYNC-C1] Commits the whole working tree, so it holds the branch's
    // content-write lock from checkout through push. Unlocked, its checkout
    // succeeds while the worker's rebase is stopped on a conflict, the commit
    // lands on the branch, and the rebase's `--abort` resets the branch past it
    // after this reported success. The push stays inside so no rebase rewrites
    // the commit between commit and push.
    const lookupEditor = memoizeLookup(options.lookupEditor)
    const readRecorded = () => readRecordedEditors(options.context)
    // Names are looked up before taking the lock, so a slow auth provider never holds it.
    const named = new Map(
      (await describeEditors((await readRecorded())?.editors ?? [], lookupEditor)).map((e) => [
        e.userId,
        e,
      ]),
    )
    let recorded: RecordedEditors = {}
    const submitted = await withContentWriteLock(options.context.branchRoot, async () => {
      await git.checkoutBranch(options.context.branch.name)
      const status = await git.status()
      // A save records its editor only after releasing this lock, so a save that lands just
      // before this submit can be committed here while its editor is named by the next commit.
      recorded = (await readRecorded()) ?? {}
      const uncommitted = recorded.uncommittedEditors ?? []
      // Commit and push answer two DIFFERENT questions. Committing cleans the
      // working tree, so one combined "tree is dirty" gate makes a retry after a
      // failed push a silent no-op: nothing left to commit, the block is skipped,
      // and success is reported though the commit never reached the remote. Push
      // whenever there is something new to send — we just committed, or the local
      // branch already had unpushed commits from an earlier attempt.
      // canopycms's own state under .canopy-meta/ is never content, so it neither
      // makes a commit worth creating nor gets staged into one.
      let committed = false
      const preCommitSha = await git.headSha()
      if (status.files.some((f) => !isCanopyInternalPath(f.path))) {
        await git.addAllExceptCanopyState()
        const committers = uncommitted.map((userId) => named.get(userId) ?? { userId })
        const trailers = buildEditorTrailers(
          options.submitter ? [options.submitter, ...committers] : committers,
          {
            editedBy: config.gitEditedByTrailers ?? true,
            coAuthoredBy: config.gitCoAuthoredByTrailers ?? false,
          },
        )
        await git.commit(
          appendTrailers(options.message ?? `Submit ${options.context.branch.name}`, trailers),
        )
        committed = true
      }
      // The diff runs after the commit so it covers saved-but-uncommitted edits too, and
      // before the push so a branch with nothing to submit never reaches the remote. A diff
      // that cannot be computed lets the submit through: the list only feeds the PR body, and
      // GitHub's own refusal of an empty branch is handled on both paths (api/github-sync.ts,
      // worker/task-runner.ts).
      let changedPaths: string[] | undefined
      try {
        changedPaths = (await git.listChangedPathsSinceBase()).filter(
          (p) => !isCanopyInternalPath(p),
        )
      } catch (err) {
        console.warn(
          `CanopyCMS: Could not list the changes on ${options.context.branch.name} against its base; ` +
            "the PR body lists only this submit's changes:",
          redactCredentials(getErrorMessage(err)),
        )
      }
      if (changedPaths?.length === 0) {
        if (committed) await git.resetKeepingChanges(preCommitSha)
        throw new NothingToSubmitError(options.context.branch.name, effectiveBase)
      }
      // A failure here leaves them uncommitted, so the next commit names them again.
      if (committed && uncommitted.length > 0) {
        try {
          await getBranchMetadataFileManager(
            options.context.branchRoot,
            options.context.baseRoot,
          ).markEditorsCommitted(uncommitted)
        } catch (err) {
          console.warn(
            `CanopyCMS: Could not clear the committed editors of ${options.context.branch.name}:`,
            getErrorMessage(err),
          )
        }
      }
      if (committed || (await git.hasUnpushedCommits(options.context.branch.name))) {
        await git.push(options.context.branch.name)
      }
      return changedPaths ?? status.files.map((f) => f.path).filter((p) => !isCanopyInternalPath(p))
    })

    // Re-read after the lock, so the PR body also names an editor whose save this commit carries
    // but who was recorded after the read above.
    const editorIds = (await readRecorded())?.editors ?? recorded.editors ?? []
    return { changedPaths: submitted, editors: await describeEditors(editorIds, lookupEditor) }
  }

  // Must be initialized before closures that reference it (commitToSettingsBranch)
  let githubService: GitHubService | undefined
  if (operatingStrategy(config.mode).supportsPullRequests()) {
    const remoteUrl = config.defaultRemoteUrl
    if (remoteUrl) {
      try {
        const service = createGitHubService(config, remoteUrl)
        if (service) {
          githubService = service
        }
      } catch (err) {
        console.warn('CanopyCMS: Failed to initialize GitHub service:', err)
        // Continue without GitHub integration
      }
    }
  }

  const commitToSettingsBranch = async (options: {
    branchRoot: string
    files: string | string[]
    message: string
  }): Promise<{
    committed: boolean
    pushed: boolean
    error?: string
    syncStatus?: 'pending-sync' | 'synced' | 'sync-failed'
  }> => {
    const mode = config.mode

    if (!operatingStrategy(mode).shouldCommit()) {
      return { committed: false, pushed: false }
    }

    const settingsBranch = operatingStrategy(config.mode).getSettingsBranchName(config)
    // Settings workspace: no ContentStore roots here, skip the index marker
    const git = createGitManagerFor(options.branchRoot, { skipIndexMarker: true })

    try {
      // Pull the remote SETTINGS branch, never the base branch: settings
      // branches are orphans and must never merge from main.
      // BranchWorkspaceManager has already put us on the settings branch.
      try {
        await git.pullCurrentBranch()
      } catch (err) {
        // Only ONE outcome here is benign: the settings branch has never been
        // pushed, so the remote has no ref to pull. Anything else — a
        // GitConflictError, a merge that cannot proceed, a broken workspace —
        // must surface (the outer catch turns it into an error result).
        if (!(err instanceof GitRemoteRefMissingError)) throw err
        console.info(
          'CanopyCMS: settings branch has no remote ref yet, nothing to pull ' +
            '(normal for the first settings commit)',
        )
      }

      await git.ensureAuthor({
        name: config.gitBotAuthorName,
        email: config.gitBotAuthorEmail,
      })
      await git.add(options.files)
      await git.commit(options.message)

      // Push to local remote (remote.git on EFS in prod, origin in other modes)
      try {
        await git.push()
      } catch (error) {
        return {
          committed: true,
          pushed: false,
          error: error instanceof Error ? error.message : 'Push failed',
        }
      }

      // The settings branch is an orphan: it shares no history with the base
      // branch, so GitHub rejects a PR for it. The change took effect when it
      // was committed and pushed above (permissions and groups are read live
      // from the settings workspace); the only GitHub step is mirroring the
      // branch, so there is never a PR.
      if (!operatingStrategy(mode).supportsPullRequests()) {
        return { committed: true, pushed: true }
      }
      // With a githubService the push above already reached GitHub: both it and
      // the workspace remote come from `defaultRemoteUrl`. Without one (prod
      // Lambda has no internet) the worker pushes it.
      if (githubService) {
        return { committed: true, pushed: true, syncStatus: 'synced' }
      }
      try {
        await enqueueTask(getTaskQueueDir(config), {
          action: 'push-branch',
          payload: { branch: settingsBranch },
        })
        return { committed: true, pushed: true, syncStatus: 'pending-sync' }
      } catch (err) {
        console.warn('Failed to enqueue settings push task:', err)
        return { committed: true, pushed: true, syncStatus: 'sync-failed' }
      }
    } catch (error) {
      return {
        committed: false,
        pushed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  const operatingMode = config.mode
  const modeStrategy = operatingStrategy(operatingMode)

  const registry = modeStrategy.supportsBranching()
    ? new BranchRegistry(getDefaultBranchBase(operatingMode))
    : undefined

  const services: CanopyServices = {
    config,
    entrySchemaRegistry: options.entrySchemaRegistry ?? {},
    branchSchemaCache,
    checkBranchAccess,
    checkContentAccess,
    createContentAccessChecker: createContentAccessCheckerBound,
    createGitManagerFor,
    registry,
    githubService,
    bootstrapAdminIds,
    commitFiles,
    submitBranch,
    commitToSettingsBranch,
    getSettingsBranchRoot,
    recordBranchEditor,
    refreshActiveBranch: async () => {
      if (services.config.mode !== 'dev') return
      // Static deployments and builds serve from the checkout — no git HEAD to track
      if (readsFromCheckout(services.config)) return
      // An explicitly configured value is never overridden by HEAD detection;
      // only what the adopter left unset is re-detected.
      if (explicitActiveBranch && explicitBaseBranch) return
      // The switch is silent, so the dev site tracks the current branch the way
      // code hot-reloads; the editor is pinned to its own branch via URL params,
      // so only non-editor content serving is affected. The base branch follows
      // HEAD too when unset, so a workspace provisioned mid-session forks from
      // the developer's current branch.
      const fresh = await detectActiveBranch({
        ...services.config,
        defaultActiveBranch: undefined,
      })
      const next = { ...services.config }
      let changed = false
      if (!explicitActiveBranch && fresh !== next.defaultActiveBranch) {
        next.defaultActiveBranch = fresh
        changed = true
      }
      if (!explicitBaseBranch && fresh !== next.defaultBaseBranch) {
        next.defaultBaseBranch = fresh
        changed = true
      }
      if (changed) {
        // The closures above (getSettingsBranchRoot, checkContentAccess,
        // createGitManagerFor, …) captured the original `config` local. Only
        // branch identity changes here: git operations on existing branches use
        // the fork point in branch metadata, and anything needing the fresh
        // values must read services.config.
        services.config = next
      }
    },
  }

  return services
}
