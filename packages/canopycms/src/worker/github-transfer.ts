import fs from 'node:fs/promises'
import { Readable } from 'node:stream'

import { GITHUB_TRACKING_REF_PREFIX } from '../git-manager'
import { getErrorMessage } from '../utils/error'
import { hasOnlyHead, scanBundleHeader, type BundleHeader } from './bundle-header'
import { runGit, spawnGit, type GitProcess } from './git-process'
import {
  MAX_FETCH_HAVE,
  type GitHubGateway,
  type GitHubPushAnswer,
  type GitHubPushOutcome,
  type GitHubPushRequest,
} from './github-gateway'
import { GitHubTransientError } from './github-mirror'
import { workerLogWarn } from './log'
import { sharedRepoGit, sharedRepoProcessOptions } from './shared-repo-git'

/**
 * The worker's side of moving objects between `remote.git` and GitHub, through the GitHub
 * gateway (worker/github-gateway.ts), which never runs git in, or opens a path in, anything the
 * Lambda can write. Objects cross as git bundles:
 * - **GitHub → remote.git:** the gateway answers a fetch with GitHub's branches and a bundle of
 *   what `remote.git` lacks; the worker unbundles it here, under the pins, and moves the tracking
 *   namespace to those branches itself ({@link fetchGitHubIntoRemoteGit}, {@link seedFromGitHub});
 * - **remote.git → GitHub:** the worker asks for the push first, and only when the gateway answers
 *   `need-objects` builds a bundle here and sends it ({@link pushToGitHub}).
 *
 * The worker does not fsck what it receives: its peer is the gateway, and the objects came from
 * GitHub. The gateway checks every object it is sent.
 */

const GIT_ZERO_OID = '0000000000000000000000000000000000000000'

/** How many times a push restarts because the branch moved while its bundle was built. */
const MAX_PUSH_RESTARTS = 3

/** What the transfers need from the worker. */
export interface TransferContext {
  github(): GitHubGateway
  readonly remoteGitPath: string
  /** The inactivity bound on each git here, as simple-git's is elsewhere. */
  readonly taskTimeoutMs: number
}

/**
 * Fetch every GitHub branch into `remote.git`'s tracking namespace (`GITHUB_TRACKING_REF_PREFIX`),
 * which then holds exactly GitHub's branches. `have` is every tip `remote.git` holds, so the
 * bundle carries only what it lacks. Returns GitHub's branches.
 */
export async function fetchGitHubIntoRemoteGit(
  ctx: TransferContext,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const gitDir = ctx.remoteGitPath
  const { refs, bundleId } = await ctx.github().fetch({ have: await haveOf(gitDir) }, signal)
  if (bundleId !== null) await unbundle(ctx, gitDir, bundleId, signal)
  await moveTrackingRefs(ctx, gitDir, refs, signal)
  return refs
}

/**
 * Seed the new bare repository at `gitDir`, which must not exist yet, with every GitHub branch as
 * `refs/heads/*`, and return those branches. Refuses, before creating anything, when GitHub has no
 * `baseBranch`.
 */
export async function seedFromGitHub(
  ctx: TransferContext,
  gitDir: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const { refs, bundleId } = await ctx.github().fetch({ have: [] }, signal)
  if (!refs.has(baseBranch)) throw new Error(`GitHub has no branch '${baseBranch}'`)
  await fs.mkdir(gitDir)
  await sharedRepoGit(gitDir, 'bare').raw(['init', '--quiet', '--bare'])
  if (bundleId !== null) await unbundle(ctx, gitDir, bundleId, signal)
  await updateRefs(
    ctx,
    gitDir,
    [...refs].map(([name, sha]) => ({ ref: `refs/heads/${name}`, to: sha, from: GIT_ZERO_OID })),
    signal,
  )
  return refs
}

/**
 * Of `ids`, the ones that are not a commit reachable from one of `tips` in the repository at
 * `gitDir`, an annotated tag counting as the commit it points at. One `cat-file --batch-check`
 * and one walk, so the answer is exactly what that repository holds.
 */
export async function unreachableFrom(
  ctx: TransferContext,
  gitDir: string,
  ids: readonly string[],
  tips: readonly string[],
): Promise<Set<string>> {
  const unreachable = new Set<string>()
  const peeled = new Map<string, string>()
  const valid = ids.filter((id) => {
    if (OBJECT_ID.test(id)) return true
    unreachable.add(id)
    return false
  })
  if (valid.length > 0) {
    const lines = (
      await runGit(['cat-file', '--batch-check=%(objectname) %(objecttype)', '--end-of-options'], {
        ...sharedRepoProcessOptions(gitDir, 'bare'),
        stdin: valid.map((id) => `${id}^{commit}\n`).join(''),
        inactivityTimeoutMs: ctx.taskTimeoutMs,
      })
    ).split('\n')
    valid.forEach((id, i) => {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) commit$/.exec(lines[i] ?? '')
      if (match) peeled.set(id, match[1])
      else unreachable.add(id)
    })
  }
  const commits = [...new Set(peeled.values())]
  if (commits.length > 0) {
    const notReached = new Set(
      (
        await runGit(['rev-list', '--stdin', '--end-of-options'], {
          ...sharedRepoProcessOptions(gitDir, 'bare'),
          stdin: [...commits, ...tips.map((tip) => `^${tip}`)].map((l) => `${l}\n`).join(''),
          inactivityTimeoutMs: ctx.taskTimeoutMs,
        })
      )
        .split('\n')
        .filter(Boolean),
    )
    for (const [id, commit] of peeled) if (notReached.has(commit)) unreachable.add(id)
  }
  return unreachable
}

/** A push to GitHub of the commit `readSha` finds, as {@link pushToGitHub} takes it. */
export interface TransferPushRequest extends Omit<GitHubPushRequest, 'sha' | 'prerequisites'> {
  /**
   * Branches whose GitHub tips, as `remote.git`'s tracking namespace holds them, a bundle of
   * `branch` is built on: the branch itself and the base. Missing ones are skipped.
   */
  prerequisiteBranches: readonly string[]
}

/**
 * Push the commit `readSha` reads to GitHub, and resolve with it and what the push did. The push
 * is asked for without objects first, which covers everything GitHub already holds; only when the
 * gateway answers `need-objects` is a bundle built from `remote.git` and sent.
 *
 * The bundle must say what was read: its one head is `<sha> refs/heads/<branch>`, checked as it
 * starts to stream. When the Lambda moved the branch in between, the push starts again from
 * `readSha` (the caller's lease and history-rewrite marker are keyed to that commit), at most
 * {@link MAX_PUSH_RESTARTS} times, so a ref moved on every pass cannot hold a task for ever.
 */
export async function pushToGitHub(
  ctx: TransferContext,
  request: TransferPushRequest,
  readSha: () => Promise<string>,
  signal?: AbortSignal,
): Promise<{ sha: string; outcome: GitHubPushOutcome }> {
  const { prerequisiteBranches, ...rest } = request
  for (let restarts = 0; ; restarts++) {
    const sha = await readSha()
    const prerequisites = await trackingTips(ctx.remoteGitPath, prerequisiteBranches)
    const ask: GitHubPushRequest = { ...rest, sha, prerequisites }
    const first = await ctx.github().push(ask, undefined, signal)
    if (first.kind === 'pushed') return { sha, outcome: outcomeOf(first) }

    const bundle = await startBundle(ctx, request.branch, sha, first.usable, signal)
    if (bundle === 'moved') {
      if (restarts < MAX_PUSH_RESTARTS) continue
      throw new GitHubTransientError(
        'ref-kept-moving',
        `${request.branch} moved in remote.git while its push was being prepared, ` +
          `${MAX_PUSH_RESTARTS + 1} times in a row`,
      )
    }
    // Nothing to bundle: what is left to send, GitHub has. A second `need-objects` would only
    // ask for the same again.
    const second = await (bundle === 'empty'
      ? ctx.github().push(ask, undefined, signal)
      : sendBundle(ctx, ask, bundle, signal))
    if (second.kind === 'pushed') return { sha, outcome: outcomeOf(second) }
    throw new GitHubTransientError(
      'objects-still-needed',
      `The GitHub gateway still lacks objects for ${request.branch} after they were offered`,
    )
  }
}

function outcomeOf(answer: GitHubPushOutcome & { kind: 'pushed' }): GitHubPushOutcome {
  const { kind: _kind, ...outcome } = answer
  return outcome
}

/** A bundle being created, its header already read and checked. */
interface StartedBundle {
  readonly process: GitProcess
  /** The whole bundle, the header included. */
  readonly stream: Readable
}

/**
 * Start `bundle create` of `refs/heads/<branch>` in `remote.git`, built on `usable`, and read its
 * header: `moved` when its head is not `sha`, `empty` when git refused an empty bundle (GitHub
 * already has every commit it would hold), else the bundle to send.
 */
async function startBundle(
  ctx: TransferContext,
  branch: string,
  sha: string,
  usable: readonly string[],
  signal?: AbortSignal,
): Promise<StartedBundle | 'moved' | 'empty'> {
  const proc = spawnGit(
    ['bundle', 'create', '--progress', '--end-of-options', '-', `refs/heads/${branch}`, '--stdin'],
    {
      ...sharedRepoProcessOptions(ctx.remoteGitPath, 'bare'),
      stdin: usable
        .filter((id) => OBJECT_ID.test(id))
        .map((id) => `^${id}\n`)
        .join(''),
      inactivityTimeoutMs: ctx.taskTimeoutMs,
      signal,
    },
  )
  const chunks = proc.stdout[Symbol.asyncIterator]()
  let start = Buffer.alloc(0)
  let unreadable: unknown = null
  try {
    for (;;) {
      const next = await chunks.next()
      if (next.done) break
      start = Buffer.concat([start, next.value as Buffer])
      let header: BundleHeader | null
      try {
        header = scanBundleHeader(start)
      } catch (err) {
        unreadable = err
        break
      }
      if (header === null) continue
      if (!hasOnlyHead(header, sha, branch)) {
        proc.kill('the branch moved')
        return 'moved'
      }
      const head = start
      return {
        process: proc,
        stream: Readable.from(
          (async function* () {
            try {
              yield head
              for (;;) {
                const rest = await chunks.next()
                if (rest.done) return
                yield rest.value as Buffer
              }
            } finally {
              // A reader that stops early releases git's stdout with it.
              await chunks.return?.()
            }
          })(),
        ),
      }
    }
  } catch (err) {
    throw await causeOf(proc, err, 'its header could not be read')
  }
  if (unreadable !== null) {
    // git writes a header with no head before it refuses an empty bundle, so its exit says which
    // this is. Otherwise the header is the failure, whatever git makes of losing its reader.
    proc.stdout.destroy()
    if (await refusedAsEmpty(proc).catch(() => false)) return 'empty'
    throw unreadable
  }
  // stdout ended before a whole header: git failed, or found nothing to bundle.
  if (await refusedAsEmpty(proc)) return 'empty'
  throw new Error(`git bundle create printed no header for ${branch}`)
}

/** Whether `bundle create` exited refusing an empty bundle; any other failure is thrown. */
async function refusedAsEmpty(proc: GitProcess): Promise<boolean> {
  try {
    await proc.exited
    return false
  } catch (err) {
    if (/Refusing to create empty bundle/.test(getErrorMessage(err))) return true
    throw err
  }
}

/**
 * Send a started bundle with the push. When the push fails, git's own failure, if it had one,
 * is the cause; otherwise the gateway's.
 */
async function sendBundle(
  ctx: TransferContext,
  request: GitHubPushRequest,
  bundle: StartedBundle,
  signal?: AbortSignal,
) {
  let answer: GitHubPushAnswer
  try {
    answer = await ctx.github().push(request, bundle.stream, signal)
  } catch (err) {
    throw await causeOf(bundle.process, err, 'the push failed')
  }
  // The gateway answered after reading the whole bundle; how git exits after that changes nothing.
  await bundle.process.exited.catch(() => undefined)
  return answer
}

/**
 * What to report for a failure while `proc` was writing a bundle: git's own failure when it had
 * one first (an abort, an inactivity kill, an error of its own), of which a stream error is only
 * the symptom, else `err`. Stops git either way, with `reason`.
 */
async function causeOf(proc: GitProcess, err: unknown, reason: string): Promise<unknown> {
  proc.kill(reason)
  const own = await proc.exited.then(
    () => null,
    (gitErr: unknown) => gitErr,
  )
  return own !== null && getErrorMessage(own) !== reason ? own : err
}

/**
 * Unbundle the gateway's bundle `bundleId` into the repository at `gitDir`, under the pins. It
 * adds objects and moves no ref.
 */
async function unbundle(
  ctx: TransferContext,
  gitDir: string,
  bundleId: string,
  signal?: AbortSignal,
): Promise<void> {
  const stream = await ctx.github().openBundle(bundleId)
  try {
    await runGit(['bundle', 'unbundle', '--progress', '--end-of-options', '-'], {
      ...sharedRepoProcessOptions(gitDir, 'bare'),
      stdin: stream,
      inactivityTimeoutMs: ctx.taskTimeoutMs,
      signal,
    })
  } finally {
    stream.destroy()
  }
}

/** One ref move: to `to` from `from` (all zeros: must not exist), or a delete when `to` is null. */
interface RefMove {
  ref: string
  to: string | null
  from: string
}

/**
 * Move the tracking namespace to exactly `refs`, every move stating the value it expects: all
 * deletions in one `update-ref` transaction, then every create and update in another. One
 * transaction cannot do both: deleting `a` and creating `a/b` together fails on the
 * directory/file conflict, and a transaction is all-or-nothing, so a GitHub-side rename of
 * `release` to `release/1.0` would freeze the namespace for ever. When a transaction fails (a
 * move lost a race on its expected value), each of its moves is tried on its own, and the losers
 * are logged; the next fetch retries them. The Lambda only reads this namespace, so per-ref
 * atomicity is all it needs.
 */
async function moveTrackingRefs(
  ctx: TransferContext,
  gitDir: string,
  refs: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const current = new Map<string, string>()
  const listing = await sharedRepoGit(gitDir, 'bare').raw([
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    '--end-of-options',
    GITHUB_TRACKING_REF_PREFIX,
  ])
  for (const line of listing.split('\n')) {
    const space = line.indexOf(' ')
    if (space !== -1) current.set(line.slice(space + 1), line.slice(0, space))
  }
  const deletions: RefMove[] = []
  for (const [ref, sha] of current) {
    if (!refs.has(ref.slice(GITHUB_TRACKING_REF_PREFIX.length))) {
      deletions.push({ ref, to: null, from: sha })
    }
  }
  const updates: RefMove[] = []
  for (const [name, sha] of refs) {
    const ref = `${GITHUB_TRACKING_REF_PREFIX}${name}`
    const from = current.get(ref)
    if (from !== sha) updates.push({ ref, to: sha, from: from ?? GIT_ZERO_OID })
  }
  for (const moves of [deletions, updates]) {
    if (moves.length === 0) continue
    try {
      await updateRefs(ctx, gitDir, moves, signal)
    } catch (err) {
      if (!lostRace(err)) throw err
      const losers: string[] = []
      for (const move of moves) {
        await updateRefs(ctx, gitDir, [move], signal).catch((moveErr: unknown) => {
          if (!lostRace(moveErr)) throw moveErr
          losers.push(move.ref)
        })
      }
      if (losers.length > 0) {
        workerLogWarn(
          `Could not move ${losers.length} GitHub tracking ref(s) (concurrent update?), retrying ` +
            `next sync: ${losers.join(', ')} (${getErrorMessage(err).trim()})`,
        )
      }
    }
  }
}

/**
 * Whether `update-ref` failed because a ref was not at the value a move stated, or a lock was
 * held: git's "cannot lock ref" for each. Anything else (an abort, a missing object) is not a race
 * a per-ref retry can win.
 */
function lostRace(err: unknown): boolean {
  return /cannot lock ref/.test(getErrorMessage(err))
}

/** Apply `moves` as one `update-ref` transaction, NUL-separated, so no refname can split a line. */
async function updateRefs(
  ctx: TransferContext,
  gitDir: string,
  moves: readonly RefMove[],
  signal?: AbortSignal,
): Promise<void> {
  const input = moves
    .map((move) => {
      if (move.ref.includes('\0'))
        throw new Error(`A ref name holds a NUL: ${JSON.stringify(move.ref)}`)
      return move.to === null
        ? `delete ${move.ref}\0${move.from}\0`
        : `update ${move.ref}\0${move.to}\0${move.from}\0`
    })
    .join('')
  await runGit(['update-ref', '-z', '--stdin', '--end-of-options'], {
    ...sharedRepoProcessOptions(gitDir, 'bare'),
    stdin: input,
    inactivityTimeoutMs: ctx.taskTimeoutMs,
    signal,
  })
}

/**
 * What `gitDir` has, for a fetch's `have`, up to {@link MAX_FETCH_HAVE} IDs: its GitHub tracking
 * tips first, which describe most of what GitHub has, then its branches' tips. With no tracking
 * ref at all (a remote.git no fetch has written yet), a branch ahead of GitHub names no commit
 * the gateway holds, and the bundle would resend history remote.git already has, so each branch
 * then adds its first-parent ancestors 1, 2, 4, … commits back, as git's own negotiation does.
 */
async function haveOf(gitDir: string): Promise<string[]> {
  const list = async (namespace: string) =>
    (
      await sharedRepoGit(gitDir, 'bare').raw([
        'for-each-ref',
        '--format=%(objectname)',
        '--end-of-options',
        namespace,
      ])
    )
      .split('\n')
      .filter((id) => OBJECT_ID.test(id))
  const tracking = await list(GITHUB_TRACKING_REF_PREFIX)
  const heads = await list('refs/heads/')
  const have = new Set([...tracking, ...heads])
  if (tracking.length === 0) {
    for (const tip of new Set(heads)) {
      if (have.size >= MAX_FETCH_HAVE) break
      const ancestors = (
        await sharedRepoGit(gitDir, 'bare').raw([
          'rev-list',
          '--first-parent',
          `--max-count=${SKIP_LIST_DEPTH}`,
          '--end-of-options',
          tip,
        ])
      )
        .split('\n')
        .filter((id) => OBJECT_ID.test(id))
      for (let step = 1; step < ancestors.length; step *= 2) have.add(ancestors[step])
      if (ancestors.length > 0) have.add(ancestors[ancestors.length - 1])
    }
  }
  return [...have].slice(0, MAX_FETCH_HAVE)
}

/** How far back {@link haveOf} looks along one branch. */
const SKIP_LIST_DEPTH = 4096

/** The tracking-namespace tips of `branches` in `gitDir`, skipping any it lacks. */
async function trackingTips(gitDir: string, branches: readonly string[]): Promise<string[]> {
  const tips: string[] = []
  for (const branch of new Set(branches)) {
    const sha = await sharedRepoGit(gitDir, 'bare')
      .raw([
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${GITHUB_TRACKING_REF_PREFIX}${branch}`,
      ])
      .then((out) => out.split('\n')[0] ?? '')
      .catch(() => '')
    if (OBJECT_ID.test(sha) && !tips.includes(sha)) tips.push(sha)
  }
  return tips
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
