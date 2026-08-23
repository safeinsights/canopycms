import type { Octokit } from '@octokit/rest'
import type { SanitizedBranchName } from '../paths/types'
import type { TaskQueueLogger } from './task-queue'
import type { WorkerStatusReport } from '../types'

/**
 * The slice of {@link import('./cms-worker').CmsWorker} that its extracted
 * clusters (task-runner.ts, git-sync.ts, rebase.ts, history-rewrite.ts) are
 * allowed to reach.
 *
 * `CmsWorker` used to be 2,949 lines holding four disjoint call trees under one
 * entry point, sharing six helper methods and a 16-field config. The clusters
 * now live in their own modules as free functions taking this context, and the
 * class keeps thin delegating methods. This interface is what makes the sharing
 * explicit: it is the ONLY channel between the class and the extracted code, so
 * "what does the rebase loop actually need from the worker?" has an answer you
 * can read, rather than being whatever `this.` happens to resolve to.
 *
 * Each module narrows it further with a `Pick<WorkerContext, ...>` alias, so a
 * function's signature names its real dependency set rather than the union.
 *
 * ## Why the second group are FUNCTIONS, not fields
 *
 * Everything below the divider is resolved by CALLING back onto the live
 * `CmsWorker` instance, never snapshotted into the context object. That is
 * load-bearing, not stylistic. The worker's eight test files drive it by
 * reaching through the instance:
 *
 * - `cms-worker.test.ts` and `cms-worker-sync-reconcile.test.ts` REPLACE
 *   `buildGitHubUrl` on the instance to redirect pushes at a local fixture repo
 *   instead of github.com;
 * - `cms-worker-merge-poll.test.ts` and `cms-worker.test.ts` ASSIGN a mock over
 *   the `octokit` field;
 * - several set `running` directly instead of calling `start()`;
 * - `cms-worker-content-lock.test.ts` SUBCLASSES `CmsWorker` to override the two
 *   `afterConflictDetectedForTesting`/`afterRebaseCompletedForTesting` hooks.
 *
 * A context built with `octokit: this.octokit` would capture the real Octokit
 * before the test ever installs its mock, and a captured `buildGitHubUrl` string
 * would send a test's push to github.com for real. Writing them as functions
 * (`ctx.octokit()`, `ctx.buildGitHubUrl()`) makes the late binding visible at
 * every call site, which a getter would hide. `CmsWorker.ctx()` builds a fresh
 * context per call for the same reason — there is no long-lived object for a
 * stale reference to hide in.
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
   * The base branch's workspace DIRECTORY name. Computed once so every
   * filesystem call site agrees instead of re-deriving it and risking drift.
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
   * The tokenized GitHub clone URL, read at call time (tests replace this
   * method to point at a local fixture repo).
   *
   * Anything derived from it can embed the bot token, so a message that reaches
   * worker-status.json, branch.json or a task file must go through
   * `redactCredentials` first.
   */
  buildGitHubUrl(): string
  /**
   * Workspace directory for a branch named by its GIT REF name — the form task
   * payloads carry. Sanitizes; `feature/x` lives in `feature-x`.
   */
  branchWorkspacePath(branchRefName: string): string
  /** Whether the worker is still running; both poll loops bail when false. */
  isRunning(): boolean
  /** The worker's self-reported status object, lazily initialized. */
  ensureStatusReport(): WorkerStatusReport
  /** This deployment's own settings branch name. Throws on an invalid name. */
  ensureSettingsBranch(): string
  /**
   * Test hook: fires when the rebase has reported conflicted files and is about
   * to `checkout --theirs` them. No-op in production; overridden by a subclass
   * in cms-worker-content-lock.test.ts.
   */
  afterConflictDetectedForTesting(): Promise<void>
  /**
   * Test hook: fires after the rebase round loop completes, deliberately
   * OUTSIDE its try/catch so a throwing hook can never be misread as a rebase
   * error. No-op in production.
   */
  afterRebaseCompletedForTesting(): Promise<void>
}
