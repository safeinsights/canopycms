import type { Octokit } from '@octokit/rest'
import type { SanitizedBranchName } from '../paths/types'
import type { Task, TaskQueueLogger } from '../task-queue/cms-task-queue'
import type { WorkerStatusReport } from '../types'

/**
 * The slice of {@link import('./cms-worker').CmsWorker} that its extracted
 * clusters (task-runner.ts, git-sync.ts, rebase.ts, history-rewrite.ts) may
 * reach — the ONLY channel between the class and that code. Each module narrows
 * it further with a `Pick<WorkerContext, ...>` alias, so a function's signature
 * names its real dependency set rather than the union.
 *
 * INVARIANT: everything below the divider is a FUNCTION, resolved by CALLING
 * back onto the live instance and never snapshotted, and `CmsWorker.ctx()`
 * builds a fresh context per call. That is load-bearing, not stylistic. The
 * `cms-worker*.test.ts` files drive the class by reaching through the instance:
 * they REPLACE `buildGitHubUrl` (aiming pushes at a local fixture repo rather
 * than github.com), `executeTask` and `pushBranchToGitHub`, ASSIGN a mock over
 * the `octokit` field, set `running` directly, and SUBCLASS to override the two
 * rebase test hooks. A context that captured any of those at construction would
 * hand the extracted code the pre-test value — which for `buildGitHubUrl` means
 * a test's push going to github.com for real. Functions (`ctx.octokit()`) make
 * the late binding visible at every call site, which a getter would hide.
 */
export interface WorkerContext {
  // --- Resolved once in the constructor and never mutated. Safe to copy. ---

  /** GitHub owner, e.g. 'safeinsights'. */
  readonly githubOwner: string
  /** GitHub repo name. */
  readonly githubRepo: string
  /**
   * The base branch's RAW git ref name. Git refs (fetch/rev-list/merge against
   * it) must use this; filesystem paths must use `sanitizedBaseBranch`.
   */
  readonly baseBranch: string
  /**
   * The base branch's workspace DIRECTORY name, computed once so every
   * filesystem call site agrees instead of re-deriving it.
   */
  readonly sanitizedBaseBranch: SanitizedBranchName
  /** `{workspacePath}/.tasks` — the task queue and worker-status.json. */
  readonly taskDir: string
  /** `{workspacePath}/remote.git` — the shared bare repo. */
  readonly remoteGitPath: string
  /** `{workspacePath}/content-branches` — the branch workspace root. */
  readonly contentBranchesPath: string
  /** Content root directory name relative to repo root (default: 'content'). */
  readonly contentRoot: string
  /** Per-task timeout in ms; also simple-git's inactivity block timeout. */
  readonly taskTimeoutMs: number
  /** Max tasks to process per `processTaskQueue` cycle. */
  readonly maxTasksPerCycle: number
  /** Default max retries for a failed task that does not carry its own. */
  readonly maxRetries: number
  /** Task-queue debug logger. */
  readonly log: TaskQueueLogger

  // --- Live dispatch back onto the instance. See the note above: these MUST
  // --- stay functions, and must never be cached by a caller.

  /** The worker's Octokit client, read at call time (tests replace it). */
  octokit(): Octokit
  /**
   * The tokenized GitHub clone URL, resolved at call time (tests replace this
   * method to point at a local fixture repo). Async because under GitHub App
   * auth the credential is minted on demand and lasts about an hour (see
   * worker/github-auth.ts); the token path resolves immediately.
   *
   * A caller that needs the URL more than once resolves it ONCE into a local --
   * see pushBranchToGitHub, where a second resolution inside the stale-lease
   * catch would replace the very error being classified. Anything derived from
   * it can embed the bot token, so a message reaching worker-status.json,
   * branch.json or a task file goes through `redactCredentials` first.
   */
  buildGitHubUrl(): Promise<string>
  /**
   * Re-read the GitHub credential because an operation that used it just
   * failed, read at call time. Best-effort and NEVER throws: a failed read, or
   * one that does not settle within `taskTimeoutMs`, is logged and swallowed,
   * because every caller is already reporting the failure that matters. The
   * next `buildGitHubUrl()`/`octokit()` sees any rotated value. See
   * `CmsWorker.refreshGitHubCredential`.
   */
  refreshGitHubCredential(): Promise<void>
  /**
   * Workspace directory for a branch named by its GIT REF name — the form task
   * payloads carry. Sanitizes; `feature/x` lives in `feature-x`.
   */
  branchWorkspacePath(branchRefName: string): string
  /**
   * Run one task, read at call time. Routed back through the instance even
   * though the implementation lives in task-runner.ts beside its only caller,
   * because cms-worker.test.ts REPLACES this method on the instance:
   * `executeTaskWithTimeout` must call `ctx.executeTask(...)`, never the
   * module-level function, which would silently bypass the stub.
   */
  executeTask(task: Task, signal: AbortSignal): Promise<Record<string, unknown>>
  /**
   * Push a branch from remote.git to GitHub, read at call time. Routed through
   * the instance for the same reason as `executeTask`: cms-worker.test.ts
   * replaces it with a spy and asserts the spy was NOT called on the
   * base-branch-refusal path.
   */
  pushBranchToGitHub(branch: string): Promise<void>
  /** Whether the worker is still running; both poll loops bail when false. */
  isRunning(): boolean
  /** The worker's self-reported status object, lazily initialized. */
  ensureStatusReport(): WorkerStatusReport
  /** This deployment's own settings branch name. Throws on an invalid name. */
  ensureSettingsBranch(): string
  /**
   * Test hook: fires when the rebase has reported conflicted files and is about
   * to `checkout --theirs` them. No-op in production.
   */
  afterConflictDetectedForTesting(): Promise<void>
  /**
   * Test hook: fires after the rebase round loop completes, deliberately
   * OUTSIDE its try/catch so a throwing hook can never be misread as a rebase
   * error. No-op in production.
   */
  afterRebaseCompletedForTesting(): Promise<void>
}
