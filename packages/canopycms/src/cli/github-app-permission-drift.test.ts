/**
 * The guard that keeps `CANOPY_APP_PERMISSIONS` honest.
 *
 * The permission set is only worth declaring if it stays in step with the code
 * that forces it. An adopter whose App is one permission short does not get a
 * clear error — `convert-to-draft`'s GraphQL failure carries no HTTP status, so
 * the worker's classifier reads a permission denial as transient and retries the
 * branch into `sync-failed`, and `createOrUpdatePullRequest` swallows a failed
 * `markPullRequestReadyForReview` by design. Both surface hours after whoever
 * added the call has moved on.
 *
 * WHY THIS OBSERVES BEHAVIOUR RATHER THAN GREPPING THE SOURCE
 *
 * The first draft of this guard scanned for `octokit.pulls.*`. It would have
 * been blind, because the call sites are written three different ways:
 *
 *     octokit.pulls.list(...)              github-service.ts, module function
 *     this.octokit.git.deleteRef(...)      github-service.ts, class methods
 *     ctx.octokit().pulls.create(...)      worker/task-runner.ts, worker/rebase.ts
 *
 * and one of them spans lines (`await ctx\n  .octokit()\n  .graphql(`), which no
 * single-line regex matches at all. Three spellings is the point at which the
 * instrument is wrong rather than merely incomplete, so this drives the real
 * dispatch table against a recording Proxy and reads back what was actually
 * invoked. A call site rewritten in a shape nobody anticipated is still seen.
 *
 * THE COMPARISON RUNS IN BOTH DIRECTIONS, WHICH IS WHAT STOPS IT PASSING VACUOUSLY
 *
 *   - an operation observed that OPERATION_PERMISSIONS does not carry -> red
 *     (a GitHub call was added and nobody widened the App)
 *   - an operation in OPERATION_PERMISSIONS that was never observed -> red
 *     (it was removed or renamed, or this harness stopped reaching it — the
 *     failure where the guard keeps passing while watching nothing)
 *
 * WHAT IT CANNOT SEE, stated rather than implied: only what this harness drives.
 * A future module that calls GitHub outside `executeTask`, `GitHubService` and
 * `pollMergeState` is invisible to it — which is what the source-level backstop
 * at the bottom of this file is for, and why that backstop is also a set
 * comparison rather than a one-way check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Octokit } from '@octokit/rest'
import { CANOPY_APP_PERMISSIONS } from './init-github-app'
import { executeTask } from '../worker/task-runner'
import type { TaskRunnerContext } from '../worker/task-runner'
import { createOrUpdatePullRequest, GitHubService } from '../github-service'
import { pollMergeState } from '../worker/rebase'
import type { RebaseContext } from '../worker/rebase'
import type { TaskAction } from '../worker/task-queue'
import type { Task } from '../task-queue/index'
import { mockConsole, type MockConsole } from '../test-utils'

/**
 * Every GitHub operation this package performs, and the App permission that
 * grants it. The other half of the derivation in `CANOPY_APP_PERMISSIONS` —
 * that constant says WHICH permissions; this says which calls force them.
 */
const OPERATION_PERMISSIONS: Readonly<Record<string, keyof typeof CANOPY_APP_PERMISSIONS>> = {
  // GitHub's permissions reference: List/Get are Pull requests/read,
  // Create/Update are Pull requests/write.
  'pulls.list': 'pull_requests',
  'pulls.get': 'pull_requests',
  'pulls.create': 'pull_requests',
  'pulls.update': 'pull_requests',
  // DELETE /repos/{o}/{r}/git/refs/{ref} is Contents/write — not
  // `administration`, which is the plausible wrong guess.
  'git.deleteRef': 'contents',
  // markPullRequestReadyForReview / convertPullRequestToDraft. GitHub's
  // permissions reference enumerates REST endpoints only, so this one is
  // derived by analogy with the REST PR mutations and is the single entry with
  // no documentation line behind it.
  graphql: 'pull_requests',
}

/** Every action the worker can be asked to perform. Kept exhaustive by the type. */
const ALL_TASK_ACTIONS: readonly TaskAction[] = [
  'push-branch',
  'push-and-create-pr',
  'push-and-update-pr',
  'push-and-create-or-update-pr',
  'convert-to-draft',
  'close-pr',
  'delete-remote-branch',
]

type Responses = Record<string, unknown>

/**
 * An Octokit whose every namespace and method is a Proxy that records
 * `namespace.method` and answers with canned data.
 *
 * Unknown methods answer rather than throw on purpose: a call added tomorrow
 * must be RECORDED (and then fail the comparison loudly, naming itself) rather
 * than blow up inside the code under test with a stack trace that buries what
 * happened.
 */
function recordingOctokit(seen: Set<string>, responses: Responses = {}): Octokit {
  const namespaceProxy = (namespace: string) =>
    new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== 'string') return undefined
          const operation = `${namespace}.${method}`
          return (..._args: unknown[]) => {
            seen.add(operation)
            return Promise.resolve(responses[operation] ?? { data: {} })
          }
        },
      },
    )

  const root = {
    graphql: (..._args: unknown[]) => {
      seen.add('graphql')
      return Promise.resolve({})
    },
  }

  return new Proxy(root, {
    get(target, prop) {
      // `then` must stay undefined or an `await` on this object would try to
      // treat it as a thenable and hang.
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (prop === 'graphql') return target.graphql
      return namespaceProxy(prop)
    },
  }) as unknown as Octokit
}

/** A TaskRunnerContext stubbed down to what `executeTask` actually touches. */
function taskContext(octokit: Octokit): TaskRunnerContext {
  const pushed: string[] = []
  const context = {
    githubOwner: 'an-org',
    githubRepo: 'a-content-site',
    baseBranch: 'main',
    octokit: () => octokit,
    // Git-over-HTTPS is covered by `contents: write` and is not an Octokit
    // call, so the push itself is stubbed out — this harness is about the REST
    // and GraphQL surface.
    pushBranchToGitHub: async (branch: string) => {
      pushed.push(branch)
    },
  }
  return context as unknown as TaskRunnerContext
}

function task(action: TaskAction): Task {
  return {
    id: 't1',
    action,
    payload: { branch: 'content/a', pullRequestNumber: 7, title: 'T', body: 'B' },
  } as unknown as Task
}

/**
 * The operations each driver invoked, kept SEPARATE rather than unioned.
 *
 * Unioning them was the first shape of this and it hid a real hole: three of
 * the four drivers call `pulls.get`, so `pollMergeState` could stop being
 * reached entirely and the combined set would not change. Per-driver floors
 * make each contribution provable on its own.
 */
type Coverage = Record<'tasks' | 'createOrUpdate' | 'service' | 'mergePoll', string[]>

async function observeEverything(): Promise<Coverage> {
  const signal = new AbortController().signal

  // 1. Every task action, against an Octokit whose `pulls.list` returns nothing
  //    — so `push-and-create-or-update-pr` takes its CREATE path.
  const tasks = new Set<string>()
  const taskOctokit = recordingOctokit(tasks, {
    'pulls.list': { data: [] },
    'pulls.create': { data: { number: 7, html_url: 'https://example.invalid/pr/7' } },
    'pulls.get': { data: { node_id: 'PR_1', state: 'open', merged: false, draft: false } },
  })
  for (const action of ALL_TASK_ACTIONS) {
    await executeTask(taskContext(taskOctokit), task(action), signal)
  }

  // 2. The UPDATE path of createOrUpdatePullRequest, which the create path
  //    above never reaches: an existing open DRAFT PR, so `pulls.update` runs
  //    and `markReadyIfDraft` fires the GraphQL mutation.
  const createOrUpdate = new Set<string>()
  await createOrUpdatePullRequest({
    octokit: recordingOctokit(createOrUpdate, {
      'pulls.list': {
        data: [
          { number: 7, node_id: 'PR_1', draft: true, html_url: 'https://example.invalid/pr/7' },
        ],
      },
    }),
    owner: 'an-org',
    repo: 'a-content-site',
    head: 'content/a',
    base: 'main',
    title: 'T',
    body: 'B',
    markReadyIfDraft: true,
  })

  // 3. Every GitHubService method. It builds its own Octokit in the
  //    constructor, so the instance field is replaced — a narrow cast, and the
  //    alternative (threading a client through the constructor) would change
  //    shipped API for a test's benefit.
  const service = new Set<string>()
  const instance = new GitHubService({ token: 'unused', owner: 'an-org', repo: 'a-content-site' })
  ;(instance as unknown as { octokit: Octokit }).octokit = recordingOctokit(service, {
    'pulls.list': { data: [] },
    'pulls.create': { data: { number: 7, html_url: 'https://example.invalid/pr/7' } },
    'pulls.update': { data: { number: 7, html_url: 'https://example.invalid/pr/7' } },
    'pulls.get': {
      data: {
        number: 7,
        node_id: 'PR_1',
        state: 'open',
        merged: false,
        draft: false,
        html_url: 'https://example.invalid/pr/7',
        head: { ref: 'content/a' },
        base: { ref: 'main' },
      },
    },
  })
  await instance.createPullRequest({ branchName: 'content/a', title: 'T', body: 'B' })
  await instance.updatePullRequest(7, { title: 'T', body: 'B' })
  await instance.createOrUpdatePR({ head: 'content/a', base: 'main', title: 'T', body: 'B' })
  await instance.getPullRequest(7)
  await instance.convertToDraft(7)
  await instance.convertToReady(7)
  await instance.closePullRequest(7)
  await instance.deleteBranch('content/a')

  // 4. The rebase loop's merge poll — the one Octokit call outside the other
  //    three, and the one a unioned set could not see disappear.
  const mergePoll = new Set<string>()
  const rebaseOctokit = recordingOctokit(mergePoll, {
    'pulls.get': { data: { merged: false, merged_at: null, state: 'open' } },
  })
  const rebaseContext = {
    githubOwner: 'an-org',
    githubRepo: 'a-content-site',
    taskTimeoutMs: 1000,
    octokit: () => rebaseOctokit,
  } as unknown as RebaseContext
  await pollMergeState(rebaseContext, 'content-a', '/tmp/nowhere', {
    branch: { pullRequestNumber: 7 },
  } as unknown as Parameters<typeof pollMergeState>[3])

  return {
    tasks: [...tasks].sort(),
    createOrUpdate: [...createOrUpdate].sort(),
    service: [...service].sort(),
    mergePoll: [...mergePoll].sort(),
  }
}

/** Everything any driver invoked. */
function allOperations(coverage: Coverage): string[] {
  return [...new Set(Object.values(coverage).flat())].sort()
}

describe('the declared App permissions cover every GitHub call this package makes', () => {
  // Driving the real dispatch table means driving its real logging: `Created PR
  // #7`, `Converted PR #7 to draft`, and a swallowed poll warning. CI turns
  // stray console output into unhandled rejections (see
  // DEVELOPING.md#expecting-console-messages), and a local run prints it rather
  // than failing — so without this the suite is green here and red there.
  let consoleSpy: MockConsole
  beforeEach(() => {
    consoleSpy = mockConsole()
  })
  afterEach(() => {
    consoleSpy.restore()
  })

  it('reaches every driver it claims to drive', async () => {
    // THE FLOOR, and it is per-driver on purpose. Every direction-checking
    // assertion below is meaningless if the harness silently stopped reaching
    // the code, and a single unioned set could not see one driver go dark
    // because three of the four call `pulls.get`. If this goes red, fix the
    // harness — do not relax the assertions after it.
    const coverage = await observeEverything()
    expect(coverage.tasks).toEqual([
      'git.deleteRef',
      'graphql',
      'pulls.create',
      'pulls.get',
      'pulls.list',
      'pulls.update',
    ])
    // The update path: an existing DRAFT PR, so update runs and the
    // mark-ready mutation fires. `pulls.create` is deliberately absent — that
    // is the create path, covered above.
    expect(coverage.createOrUpdate).toEqual(['graphql', 'pulls.list', 'pulls.update'])
    expect(coverage.service).toEqual([
      'git.deleteRef',
      'graphql',
      'pulls.create',
      'pulls.get',
      'pulls.list',
      'pulls.update',
    ])
    expect(coverage.mergePoll).toEqual(['pulls.get'])
  })

  it('accounts for every operation that was actually invoked', async () => {
    const seen = allOperations(await observeEverything())
    const unaccounted = seen.filter((op) => OPERATION_PERMISSIONS[op] === undefined)
    expect(
      unaccounted,
      'A GitHub call was added that the App manifest does not account for. Add it to ' +
        'OPERATION_PERMISSIONS, and widen CANOPY_APP_PERMISSIONS if it needs a permission ' +
        'the App does not already request.',
    ).toEqual([])
  })

  it('observes every operation it claims to account for', async () => {
    // The other direction, and the one that catches a guard going blind: a
    // mapped operation nothing invokes means either the call was removed (so
    // the map is stale) or the harness stopped reaching it (so the map is
    // watching nothing).
    const seen = new Set(allOperations(await observeEverything()))
    const unobserved = Object.keys(OPERATION_PERMISSIONS).filter((op) => !seen.has(op))
    expect(
      unobserved,
      'OPERATION_PERMISSIONS names an operation nothing invoked. Either the call site was ' +
        'removed — delete the entry — or this harness no longer reaches it, in which case the ' +
        'guard is watching nothing.',
    ).toEqual([])
  })

  it('maps every operation onto a permission the App actually requests', async () => {
    for (const [operation, permission] of Object.entries(OPERATION_PERMISSIONS)) {
      expect(
        CANOPY_APP_PERMISSIONS[permission],
        `${operation} is mapped to "${permission}", which the App does not request`,
      ).toBeDefined()
    }
  })

  it('requests no permission that no operation needs', async () => {
    // `metadata` is the deliberate exception: GitHub grants it alongside any
    // repository permission, so it is declared without any call forcing it.
    const needed = new Set(Object.values(OPERATION_PERMISSIONS))
    needed.add('metadata')
    expect(Object.keys(CANOPY_APP_PERMISSIONS).sort()).toEqual([...needed].sort())
  })
})

describe('the source-level backstop', () => {
  /**
   * Matches a call THROUGH an octokit client in any of the three shapes used in
   * this package, across line breaks. Declarations (`octokit(): Octokit`) and
   * other identifiers that merely start with "octokit" (`octokitClient()`) do
   * not match, because a `.` must follow.
   *
   * Linear by construction, despite the nested-quantifier shape the linter's
   * heuristic flags. Every adjacent quantifier here ranges over a DISJOINT
   * character class — `[\w$]` excludes whitespace, `\s` excludes word
   * characters, and the optional group can only begin at a literal `.`, which
   * is in neither. So any matched span has exactly one decomposition into those
   * pieces and there is nothing for the engine to backtrack over. It also only
   * ever runs over this package's own source files, not over input.
   */

  const OCTOKIT_CALL =
    // eslint-disable-next-line security/detect-unsafe-regex -- linear, see above
    /\boctokit(?:\(\))?\s*\.\s*[A-Za-z_$][\w$]*\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?\(/

  function filesWithOctokitCalls(): string[] {
    const root = join(__dirname, '..')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!full.endsWith('.ts')) continue
        if (full.includes('.test.') || full.includes(`${join('src', 'test-utils')}`)) continue
        if (OCTOKIT_CALL.test(readFileSync(full, 'utf8'))) {
          found.push(relative(root, full).split('\\').join('/'))
        }
      }
    }
    walk(root)
    return found.sort()
  }

  it('finds Octokit calls in exactly the three files the behavioural guard drives', () => {
    // A set comparison, both directions at once. A FOURTH file appearing means
    // the behavioural guard above is no longer watching everything — it only
    // sees what its harness drives, and this is what notices that.
    expect(filesWithOctokitCalls()).toEqual([
      'github-service.ts',
      'worker/rebase.ts',
      'worker/task-runner.ts',
    ])
  })

  it('matches all three call spellings, including the multi-line one', () => {
    // The regex itself is pinned, because a regex that quietly stops matching
    // turns the assertion above into "no files have Octokit calls" — green, and
    // watching nothing.
    expect(OCTOKIT_CALL.test('await octokit.pulls.list({')).toBe(true)
    expect(OCTOKIT_CALL.test('await this.octokit.git.deleteRef({')).toBe(true)
    expect(OCTOKIT_CALL.test('await ctx.octokit().pulls.create({')).toBe(true)
    expect(OCTOKIT_CALL.test('await ctx\n  .octokit()\n  .graphql(\n')).toBe(true)
    // And does not match the declaration or the similarly-named accessor.
    expect(OCTOKIT_CALL.test('octokit(): Octokit')).toBe(false)
    expect(OCTOKIT_CALL.test('return this.octokitClient()')).toBe(false)
  })
})
