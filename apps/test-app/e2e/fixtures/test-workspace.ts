import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { testLogger as log } from '../../../../packages/canopycms/src/utils/debug'
import { bumpResourceGeneration } from '../../../../packages/canopycms/src/resource-generation'
import { resetTaskQueue } from './admin-workspace'
import { resetAssetStore } from './media-workspace'

/**
 * Base path for the test-app workspace.
 * With sourceRoot: 'apps/test-app', the .canopycms directory is created under the test-app.
 */
const TEST_APP_ROOT = path.resolve(process.cwd(), 'apps/test-app')

/**
 * Path to the .canopy-dev/content-branches directory where dev mode stores branches.
 */
const BRANCHES_DIR = path.join(TEST_APP_ROOT, '.canopy-dev/content-branches')

/**
 * Get the path to the main branch content directory.
 */
export function getMainBranchPath(): string {
  return path.join(BRANCHES_DIR, 'main')
}

/**
 * Get the path to a content file within the main branch.
 * @param contentPath - Relative path within content/ (e.g., 'home.json')
 */
export function getContentFilePath(contentPath: string): string {
  return path.join(getMainBranchPath(), 'content', contentPath)
}

/**
 * Read and parse a JSON content file from the main branch.
 * @param contentPath - Relative path within content/ (e.g., 'home.json')
 */
export async function readContentFile<T = unknown>(contentPath: string): Promise<T> {
  const filePath = getContentFilePath(contentPath)
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content) as T
}

/**
 * Read a raw content file from the main branch (without parsing).
 * Useful for YAML files or format-agnostic verification.
 * @param contentPath - Relative path within content/
 */
export async function readRawContentFile(contentPath: string): Promise<string> {
  const filePath = getContentFilePath(contentPath)
  return fs.readFile(filePath, 'utf8')
}

/**
 * Find a content file in the main branch by a prefix pattern.
 * The prefix may include a subdirectory (e.g., 'posts.qrstuvwxyz12/post.post.').
 * Returns the relative content path from content/ root (e.g., 'posts.qrstuvwxyz12/post.post.abc123.json').
 *
 * NOTE: Uses Array.find, so returns the **first** filesystem-order match.
 * Callers must ensure the prefix is specific enough that only one file matches.
 *
 * @param prefix - Filename prefix to match, optionally including a subdir (e.g., 'posts.qrstuvwxyz12/post.post.')
 */
export async function findContentFile(prefix: string): Promise<string | null> {
  const contentDir = path.join(getMainBranchPath(), 'content')
  const slashIdx = prefix.indexOf('/')
  if (slashIdx !== -1) {
    const subdir = prefix.substring(0, slashIdx)
    const filePrefix = prefix.substring(slashIdx + 1)
    const subdirPath = path.join(contentDir, subdir)
    try {
      const entries = await fs.readdir(subdirPath)
      const match = entries.find((e) => e.startsWith(filePrefix))
      return match ? `${subdir}/${match}` : null
    } catch {
      return null
    }
  }
  const entries = await fs.readdir(contentDir)
  const match = entries.find((e) => e.startsWith(prefix))
  return match ?? null
}

/**
 * Check if the main branch workspace exists.
 */
export async function workspaceExists(): Promise<boolean> {
  try {
    await fs.access(getMainBranchPath())
    return true
  } catch {
    return false
  }
}

/**
 * Baseline marker: the main clone's HEAD sha captured right after its first
 * provisioning. Lives inside .canopy-meta so `git clean -e .canopy-meta`
 * preserves it. The cheap reset restores the working tree to exactly this
 * commit — more deterministic than re-cloning from remote.git, whose main
 * ref accumulates restore/conflict commits across runs.
 */
const BASELINE_FILE = 'e2e-baseline-head'
/** Pristine copy of branch.json, captured alongside the baseline sha, so the
 * cheap reset can restore its mutable fields (conflictStatus, rebaseFailure,
 * status, …) that the preserved .canopy-meta would otherwise leak. */
const BASELINE_BRANCH_JSON = 'e2e-baseline-branch.json'

const mainBaselinePath = () => path.join(getMainBranchPath(), '.canopy-meta', BASELINE_FILE)
const mainBaselineBranchJsonPath = () =>
  path.join(getMainBranchPath(), '.canopy-meta', BASELINE_BRANCH_JSON)

/** Bump a generation marker (BUMP, never delete: a missing marker reads as
 * the valid "never bumped" null token, which can false-match a cache
 * snapshot taken before any bump). Uses the package's own atomic
 * bumpResourceGeneration (temp+rename) since the dev server may read the
 * marker concurrently — see docs/concurrency.md. */
async function bumpMarker(dir: string, resource: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.canopy-meta'), { recursive: true })
  await bumpResourceGeneration(dir, resource)
}

/**
 * Reset the workspace between tests.
 *
 * Cheap path (the common case): reset the existing main clone in place —
 * `git reset --hard <baseline>` + `git clean -fd -e .canopy-meta` undoes
 * tracked edits, untracked entry files, AND local commits (the conflict
 * tests commit on main), at a fraction of the cost of the full path's
 * delete + re-clone. Feature-branch clones are still deleted wholesale.
 *
 * Because content changes under the server's feet, every relevant
 * generation marker is bumped so cross-process caches rebuild:
 * content-index + schema for main, branch-registry for the branch list
 * (the registry then rescans per-branch .canopy-meta/branch.json files,
 * finds only main, and forgets the deleted feature branches).
 *
 * Full path (first run, or when the cheap path can't prove the baseline):
 * delete content-branches/ entirely; ensureMainBranch() re-provisions and
 * records a fresh baseline. remote.git is preserved between tests either
 * way — recreating it is expensive (git init + push + clone).
 */
export async function resetWorkspace(): Promise<void> {
  log.time('resetWorkspace')
  log.info('workspace', 'Starting workspace reset')

  // Task-queue state lives beside content-branches/ (.canopy-dev/.tasks) and
  // is not touched by either reset path below. The admin observability specs
  // seed tasks, a worker lock and a status file; without this it would leak
  // into every later test AND across whole suite runs (the state-leak proof
  // runs the suite twice without wiping .canopy-dev).
  await resetTaskQueue()

  // The asset store lives beside content-branches/ too (.canopy-dev/assets)
  // and is likewise untouched by either reset path below -- it's a separate,
  // branch-agnostic global store (assets/factory.ts). The media specs upload
  // real files through it; without this, uploaded originals/meta/transform
  // outputs would leak into every later test AND across whole suite runs
  // (same state-leak proof as the task queue above).
  await resetAssetStore()

  const mainPath = getMainBranchPath()
  const cheapReset = async (): Promise<boolean> => {
    const baseline = (await fs.readFile(mainBaselinePath(), 'utf8').catch(() => '')).trim()
    if (!baseline) return false
    const git = simpleGit({ baseDir: mainPath })
    // Verify the baseline commit still exists in this clone before resetting.
    await git.raw(['cat-file', '-e', baseline])
    // Clear any in-progress rebase state a crashed test left behind
    // (reset --hard alone would leave .git/rebase-merge poisoning later ops).
    await git.raw(['rebase', '--abort']).catch(() => {})
    await git.raw(['reset', '--hard', baseline])
    await git.raw(['clean', '-fd', '-e', '.canopy-meta'])

    // `-e .canopy-meta` preserves the whole dir, but it also holds MUTABLE
    // per-branch state that must NOT leak across tests: comments.json
    // (comment-store persistence — a leftover unresolved thread breaks
    // comments.spec's toHaveCount(1) on the next run/retry),
    // schema-cache.json, and branch.json's mutable fields (conflictStatus,
    // rebaseFailure, status). Purge the first two; restore branch.json from
    // the pristine copy captured by recordMainBaseline().
    const metaDir = path.join(mainPath, '.canopy-meta')
    await fs.rm(path.join(metaDir, 'comments.json'), { force: true })
    await fs.rm(path.join(metaDir, 'schema-cache.json'), { force: true })
    const pristineBranchJson = await fs
      .readFile(mainBaselineBranchJsonPath(), 'utf8')
      .catch(() => '')
    if (pristineBranchJson) {
      await fs.writeFile(path.join(metaDir, 'branch.json'), pristineBranchJson, 'utf8')
    }

    // Make the REMOTE deterministic too: conflict tests force-push conflict
    // commits to remote main, and a later rebase cycle would ff-merge that
    // stale content back into the freshly reset clone. Force-push the
    // baseline back (remote.git is a local bare repo — this is cheap).
    await git.push('origin', `${baseline}:refs/heads/main`, ['--force'])

    // Remove feature-branch clones from previous tests. Safe to delete their
    // generation markers wholesale (a deleted marker reads as the "never
    // bumped" null token) ONLY because branch names are Date.now()-unique per
    // test — no cached snapshot for the same branch path can exist. Keep that
    // convention when writing new specs.
    const entries = await fs.readdir(BRANCHES_DIR, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'main' && entry.name !== '.canopy-meta') {
        await fs.rm(path.join(BRANCHES_DIR, entry.name), { recursive: true, force: true })
      }
    }

    await bumpMarker(mainPath, 'content-index')
    await bumpMarker(mainPath, 'schema')
    await bumpMarker(BRANCHES_DIR, 'branch-registry')
    return true
  }

  try {
    if (await cheapReset()) {
      log.timeEnd('workspace', 'resetWorkspace')
      return
    }
  } catch (err) {
    log.warn('workspace', 'Cheap reset failed; falling back to full delete', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  log.debug('workspace', 'Deleting branches directory', { path: BRANCHES_DIR })
  await fs.rm(BRANCHES_DIR, { recursive: true, force: true }).catch(() => {})
  log.timeEnd('workspace', 'resetWorkspace')
}

/**
 * Record the main clone's pristine HEAD as the cheap-reset baseline.
 * No-op if a baseline is already recorded (cheap resets return HEAD to it,
 * so it stays valid for the whole run).
 */
export async function recordMainBaseline(): Promise<void> {
  const existing = await fs.readFile(mainBaselinePath(), 'utf8').catch(() => '')
  if (existing.trim()) return
  const git = simpleGit({ baseDir: getMainBranchPath() })
  const head = (await git.revparse(['HEAD'])).trim()
  await fs.mkdir(path.dirname(mainBaselinePath()), { recursive: true })
  await fs.writeFile(mainBaselinePath(), head, 'utf8')
  // Snapshot pristine branch.json so cheapReset can restore its mutable
  // fields (conflictStatus, rebaseFailure, …) between tests.
  const branchJson = await fs
    .readFile(path.join(path.dirname(mainBaselinePath()), 'branch.json'), 'utf8')
    .catch(() => '')
  if (branchJson) {
    await fs.writeFile(mainBaselineBranchJsonPath(), branchJson, 'utf8')
  }
  log.debug('workspace', 'Recorded main baseline', { head })
}

/**
 * Ensure the main branch workspace is initialized by calling the API.
 * This creates the branch if it doesn't exist.
 * @param baseUrl - Base URL of the test app (e.g., 'http://localhost:5174')
 */
export async function ensureMainBranch(baseUrl: string): Promise<void> {
  return log.timed('workspace', 'ensureMainBranch', async () => {
    log.info('workspace', 'Ensuring main branch exists', { baseUrl })

    // Try to create the main branch - this is idempotent
    log.debug('workspace', 'Calling create branch API')
    const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ branch: 'main' }),
    })

    log.debug('workspace', 'API response received', {
      ok: response.ok,
      status: response.status,
    })

    // 200 = created, or branch already exists with appropriate response
    if (!response.ok) {
      const body = await response.text()
      // Ignore if branch already exists (might return different status codes)
      if (body.includes('already exists') || response.status === 409) {
        log.debug('workspace', 'Branch already exists (idempotent)')
        // Continue to wait for workspace - it may still be initializing
      } else if (body.includes('Cannot create a branch with the base branch name')) {
        // Benign on checkouts whose git base branch IS 'main' (CI runs on a
        // detached PR ref, so dev-mode base detection falls back to 'main'):
        // branch protection refuses the explicit create, but the CMS 'main'
        // workspace is exactly the base workspace the system auto-provisions.
        // Auto-provisioning is LAZY (getBranchContext creates the base
        // workspace when a request references it — http/handler.ts), so issue
        // one branch-scoped request to trigger it, then fall through to
        // waitForWorkspace below.
        log.debug('workspace', "'main' is the protected base branch (auto-provisioning)")
        await fetch(`${baseUrl}/api/canopycms/main/entries`).catch(() => {})
      } else {
        // Non-idempotent failure: throw error
        log.error('workspace', 'Failed to create main branch', {
          status: response.status,
          body,
        })
        throw new Error(`Failed to ensure main branch: ${response.status} ${body}`)
      }
    }

    // NEW: Wait for workspace to be fully initialized (whether created or already exists)
    log.debug('workspace', 'Waiting for workspace initialization')
    await waitForWorkspace()

    log.debug('workspace', 'Verifying workspace readiness')
    await verifyWorkspaceReady()

    // Capture the pristine HEAD so resetWorkspace() can restore it cheaply
    // between tests (no-op when a baseline is already recorded).
    await recordMainBaseline()

    log.info('workspace', 'Main branch ready')
  })
}

/**
 * Wait for the workspace to be initialized (main branch exists).
 * Useful after resetWorkspace() when the app needs to recreate it.
 */
export async function waitForWorkspace(timeoutMs = 30000): Promise<void> {
  log.debug('workspace', 'Waiting for workspace', { timeoutMs })
  const start = Date.now()
  let attempts = 0

  while (Date.now() - start < timeoutMs) {
    attempts++
    if (await workspaceExists()) {
      log.debug('workspace', 'Workspace ready', {
        attempts,
        durationMs: Date.now() - start,
      })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  log.error('workspace', 'Workspace initialization timeout', {
    timeoutMs,
    attempts,
  })
  throw new Error(`Workspace not initialized after ${timeoutMs}ms`)
}

/**
 * Verify workspace is in a valid, ready state before tests proceed.
 */
export async function verifyWorkspaceReady(): Promise<void> {
  const mainPath = getMainBranchPath()
  const gitPath = path.join(mainPath, '.git')
  const remotePath = path.join(TEST_APP_ROOT, '.canopy-dev/remote.git')

  await Promise.all([
    fs.access(mainPath).catch(() => {
      throw new Error(`Main branch directory does not exist: ${mainPath}`)
    }),
    fs.access(gitPath).catch(() => {
      throw new Error(`Git repository not initialized in main branch: ${gitPath}`)
    }),
    fs.access(path.join(remotePath, 'config')).catch(() => {
      throw new Error(`Remote.git not properly initialized: ${remotePath}`)
    }),
    fs.access(path.join(remotePath, 'HEAD')).catch(() => {
      throw new Error(`Remote.git HEAD missing: ${remotePath}`)
    }),
  ])
}

/**
 * Wait for a specific branch workspace to be fully initialized.
 * Useful after creating a branch via API.
 */
export async function waitForBranchWorkspace(branchName: string, timeoutMs = 10000): Promise<void> {
  log.debug('workspace', 'Waiting for branch workspace', {
    branchName,
    timeoutMs,
  })
  const branchPath = path.join(BRANCHES_DIR, branchName)
  const start = Date.now()
  let attempts = 0

  while (Date.now() - start < timeoutMs) {
    attempts++
    try {
      // Check branch directory exists
      await fs.access(branchPath)
      // Check .git directory exists
      await fs.access(path.join(branchPath, '.git'))
      // Check branch metadata exists (dev stores metadata in .canopy-meta/)
      await fs.access(path.join(branchPath, '.canopy-meta', 'branch.json'))

      log.debug('workspace', 'Branch workspace ready', {
        branchName,
        attempts,
        durationMs: Date.now() - start,
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  log.error('workspace', 'Branch workspace timeout', {
    branchName,
    timeoutMs,
    attempts,
  })
  throw new Error(`Branch workspace not ready after ${timeoutMs}ms: ${branchName}`)
}

/**
 * Create a branch via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to create
 * @param userId - User ID to make the request as (via X-Test-User header)
 * @param options - Optional branch metadata (title, description, access control)
 */
export async function createBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
  options?: {
    title?: string
    description?: string
    access?: {
      allowedUsers?: string[]
      allowedGroups?: string[]
    }
  },
): Promise<Response> {
  log.debug('api', 'Creating branch via API', { branchName, userId })

  const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({
      branch: branchName,
      ...options,
    }),
  })

  // NEW: Wait for branch workspace to be initialized
  if (response.ok) {
    await waitForBranchWorkspace(branchName)
  }

  return response
}

/**
 * Delete a branch via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to delete
 * @param userId - User ID to make the request as
 */
export async function deleteBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}`, {
    method: 'DELETE',
    headers: {
      'X-Test-User': userId,
    },
  })
  return response
}

/**
 * List all branches via API.
 * @param baseUrl - Base URL of the test app
 * @param userId - User ID to make the request as
 */
export async function listBranchesViaAPI(baseUrl: string, userId: string): Promise<unknown[]> {
  const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
    method: 'GET',
    headers: {
      'X-Test-User': userId,
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to list branches: ${response.status}`)
  }
  return await response.json()
}

/**
 * Submit a branch for review (creates PR) via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to submit
 * @param userId - User ID to make the request as
 */
export async function submitBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  log.debug('api', 'Submitting branch via API', { branchName, userId })
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const body = await response.text()
    log.error('api', 'Submit failed', {
      branchName,
      status: response.status,
      body,
    })
  } else {
    log.debug('api', 'Submit successful', { branchName })
  }

  return response
}

/**
 * Withdraw a submitted branch via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to withdraw
 * @param userId - User ID to make the request as
 */
export async function withdrawBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })
  return response
}

/**
 * Approve a branch (reviewer action) via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to approve
 * @param userId - User ID to make the request as (should be reviewer or admin)
 */
export async function approveBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })
  return response
}

/**
 * Request changes on a branch (reviewer action) via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch
 * @param userId - User ID to make the request as (should be reviewer or admin)
 */
export async function requestChangesViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/request-changes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })
  return response
}

/**
 * Update branch access control via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch
 * @param userId - User ID to make the request as
 * @param access - Access control configuration
 */
export async function updateBranchAccessViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
  access: {
    allowedUsers?: string[]
    allowedGroups?: string[]
  },
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/access`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify(access),
  })
  return response
}

// ---------------------------------------------------------------------------
// Conflict testing helpers
// ---------------------------------------------------------------------------

/**
 * Commit all pending changes in a branch workspace.
 * Used to make the branch "clean" so that rebaseActiveBranches() will process it.
 * Does NOT change branch status metadata — the branch stays in "editing" status.
 */
export async function commitBranchChanges(branchName: string): Promise<void> {
  const branchPath = path.join(BRANCHES_DIR, branchName)
  const git = simpleGit({ baseDir: branchPath })
  await git.addConfig('user.name', 'CanopyCMS Test Bot')
  await git.addConfig('user.email', 'test@example.com')
  await git.add('.')
  await git.commit('E2E: branch edit')
}

/**
 * Push a conflicting change to the main branch on remote.git.
 * This creates divergence so that the next rebase on a feature branch will conflict.
 *
 * @param contentRelativePath - Path relative to the content/ dir (e.g., 'home.home.bo7QdSwn9Tod.json')
 * @param newContent - Full file content to write
 */
export async function pushConflictingChangeToMain(
  contentRelativePath: string,
  newContent: string,
): Promise<void> {
  const mainPath = path.join(BRANCHES_DIR, 'main')
  const filePath = path.join(mainPath, 'content', contentRelativePath)
  await fs.writeFile(filePath, newContent, 'utf8')

  const git = simpleGit({ baseDir: mainPath })
  await git.addConfig('user.name', 'CanopyCMS Test Bot')
  await git.addConfig('user.email', 'test@example.com')
  await git.add('.')
  await git.commit('E2E: upstream conflict trigger')
  // Force: remote.git is preserved across runs (see resetWorkspace) while the
  // main workspace is re-cloned fresh from the base snapshot, so remote
  // refs/heads/main may hold a diverged history from a previous run. This
  // fixture's contract is "make remote main exactly this state", and the
  // remote is a local test-only bare repo — force-push is the correct tool.
  await git.push('origin', 'main', ['--force'])
}

/**
 * Trigger the worker's rebaseActiveBranches() via the test-only API endpoint.
 */
export async function triggerRebase(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/e2e-test/rebase`, {
    method: 'POST',
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Rebase trigger failed: ${response.status} ${body}`)
  }
}
