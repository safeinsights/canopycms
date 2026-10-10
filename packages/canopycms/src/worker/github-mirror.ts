import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  GITHUB_TRACKING_REF_PREFIX,
  gitNetworkChildEnv,
  repackBareRemoteIfNeeded,
  type BareRemoteRepackResult,
} from '../git-manager'
import { workerLogWarn } from './log'
import { mirrorGitOptions, pinnedReceivePack, pinnedUploadPack } from './shared-repo-git'

/**
 * The worker's private bare mirror of the GitHub repository, on storage the CMS Lambda cannot
 * reach: the only repository in which git ever runs with the GitHub credential. Every
 * token-bearing fetch and push reads config and hooks from here, never from `remote.git` or a
 * branch clone, whose config the Lambda can write (see worker/shared-repo-git.ts for why `-c`
 * cannot neutralize that). Objects cross to and from `remote.git` only by local fetch and push,
 * through the pinned `upload-pack`/`receive-pack` commands.
 *
 * `refs/heads/*` mirrors GitHub as of the last fetch. `refs/canopy/outgoing/<branch>` holds a
 * commit being pushed for the length of that push. A cache: deleting it costs one full fetch.
 *
 * One process owns it, and {@link GitHubMirror.exclusive} runs one session at a time, so a fetch's
 * `--prune` and a repack never meet a push half way.
 */
export class GitHubMirror {
  readonly gitDir: string
  private tail: Promise<unknown> = Promise.resolve()
  private warnedSize = false
  private ready = false

  constructor(
    stateDirectory: string,
    private readonly remoteGitPath: string,
    private readonly timeoutMs: number,
  ) {
    this.gitDir = path.join(stateDirectory, 'github.git')
  }

  /**
   * Run `fn` with the mirror to itself, after every session started before it. Creates the
   * mirror first if it is missing, and checks again after any session that failed.
   */
  exclusive<T>(fn: (session: MirrorSession) => Promise<T>): Promise<T> {
    const start = async () => {
      if (!this.ready) {
        await this.create()
        this.ready = true
      }
      try {
        return await fn(new MirrorSession(this.gitDir, this.remoteGitPath, this.timeoutMs))
      } catch (err) {
        this.ready = false
        throw err
      }
    }
    const run = this.tail.then(start, start)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Create the mirror now rather than at its first use. */
  ensure(): Promise<void> {
    return this.exclusive(async () => undefined)
  }

  /** Create the mirror, or recreate one that is not a readable bare repository. */
  private async create(): Promise<void> {
    if (await isBareRepository(this.gitDir)) return
    await fs.rm(this.gitDir, { recursive: true, force: true })
    await fs.mkdir(this.gitDir, { recursive: true, mode: 0o700 })
    await simpleGit({ baseDir: this.gitDir, ...mirrorGitOptions() })
      .env(mirrorEnv(this.gitDir))
      .raw(['init', '--quiet', '--bare'])
  }

  /** Repack when it needs it, and say once if it has grown past {@link MIRROR_SIZE_WARN_KIB}. */
  maintain(): Promise<BareRemoteRepackResult> {
    return this.exclusive(async () => {
      const result = await repackBareRemoteIfNeeded(this.gitDir, mirrorGitOptions())
      if (!this.warnedSize) {
        const kib = await objectStoreKiB(this.gitDir)
        if (kib > MIRROR_SIZE_WARN_KIB) {
          this.warnedSize = true
          workerLogWarn(
            `The worker's GitHub mirror (${this.gitDir}) holds ${Math.round(kib / 1024)} MiB of ` +
              `objects, on the instance's root volume. See "The worker instance" in ` +
              `docs/deploying-to-aws.md for the headroom it assumes.`,
          )
        }
      }
      return result
    })
  }
}

/**
 * Past this the mirror is using a large share of the worker's default 8 GiB root volume, which
 * also holds the OS, Node and the log.
 */
const MIRROR_SIZE_WARN_KIB = 2 * 1024 * 1024

/** What one {@link GitHubMirror.exclusive} call may do. */
export class MirrorSession {
  constructor(
    private readonly gitDir: string,
    private readonly remoteGitPath: string,
    private readonly timeoutMs: number,
  ) {}

  private git(signal?: AbortSignal): SimpleGit {
    return simpleGit({
      baseDir: this.gitDir,
      ...mirrorGitOptions(),
      timeout: { block: this.timeoutMs },
      abort: signal,
    }).env(mirrorEnv(this.gitDir))
  }

  /** Bring `refs/heads/*` to exactly what GitHub holds. `githubUrl` carries the credential. */
  async fetchFromGitHub(githubUrl: string, signal?: AbortSignal): Promise<void> {
    await this.git(signal).raw([
      'fetch',
      '--prune',
      '--no-write-fetch-head',
      '--end-of-options',
      githubUrl,
      '+refs/heads/*:refs/heads/*',
    ])
  }

  /** The mirror's tip for `branch`, or null when GitHub had no such branch at the last fetch. */
  async branchTip(branch: string): Promise<string | null> {
    try {
      const sha = (
        await this.git().raw(['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}`])
      ).trim()
      return sha.length > 0 ? sha : null
    } catch {
      return null
    }
  }

  /**
   * Copy GitHub's branches into `remote.git`'s tracking namespace, pruning the ones GitHub no
   * longer has. `reconcileTrackedBranches` (worker/git-sync.ts) moves `refs/heads/*` from there.
   */
  async publishTrackingRefs(signal?: AbortSignal): Promise<void> {
    await this.pushToRemoteGit(
      this.remoteGitPath,
      [`+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`],
      signal,
      true,
    )
  }

  /** Seed a new, empty bare repository at `gitDir` with every GitHub branch. */
  async seedBareRepository(gitDir: string, signal?: AbortSignal): Promise<void> {
    await this.pushToRemoteGit(gitDir, ['+refs/heads/*:refs/heads/*'], signal, false)
  }

  private async pushToRemoteGit(
    target: string,
    refspecs: string[],
    signal: AbortSignal | undefined,
    prune: boolean,
  ): Promise<void> {
    await this.git(signal).raw([
      'push',
      ...(prune ? ['--prune'] : []),
      `--receive-pack=${pinnedReceivePack()}`,
      '--end-of-options',
      target,
      ...refspecs,
    ])
  }

  /**
   * Push exactly `sha`, which `remote.git` held for `branch` when the caller read it, to GitHub's
   * `refs/heads/<branch>`. `lease` is the commit GitHub must still be at for the push to replace
   * it (`--force-with-lease`); without one the push is an ordinary fast-forward. Fetching the
   * commit from `remote.git` first is the step that brings the Lambda's objects across, through
   * the pinned `upload-pack`.
   */
  async pushToGitHub(
    githubUrl: string,
    branch: string,
    sha: string,
    options: { lease?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!isObjectId(sha)) throw new Error(`Not a commit ID: ${JSON.stringify(sha)}`)
    const staging = `refs/canopy/outgoing/${branch}`
    const git = this.git(options.signal)
    try {
      await git.raw([
        'fetch',
        '--no-write-fetch-head',
        `--upload-pack=${pinnedUploadPack()}`,
        '--end-of-options',
        this.remoteGitPath,
        `+${sha}:${staging}`,
      ])
      await git.raw([
        'push',
        ...(options.lease ? [`--force-with-lease=refs/heads/${branch}:${options.lease}`] : []),
        '--end-of-options',
        githubUrl,
        `${sha}:refs/heads/${branch}`,
      ])
    } finally {
      // A deleted branch's leftover ref would block a later `<branch>/<x>` (a directory/file
      // conflict in the ref namespace).
      await this.git()
        .raw(['update-ref', '-d', '--end-of-options', staging])
        .catch(() => undefined)
    }
  }
}

/**
 * The network env (proxies, CA bundles, the C locale the push-rejection classifier needs), with
 * the repository named outright: a bare repository found from the working directory is refused
 * where `safe.bareRepository=explicit` is set.
 */
function mirrorEnv(gitDir: string): Record<string, string> {
  return { ...gitNetworkChildEnv(), GIT_DIR: gitDir }
}

/** A full SHA-1 or SHA-256 object ID, so nothing else can reach a refspec. */
function isObjectId(value: string): boolean {
  return (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
}

async function isBareRepository(gitDir: string): Promise<boolean> {
  try {
    await fs.access(gitDir)
    // Without the mirror's pins, whose `core.bare=true` would answer this question for git.
    const out = await simpleGit({ baseDir: gitDir }).raw([
      '--git-dir',
      gitDir,
      'rev-parse',
      '--is-bare-repository',
    ])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

async function objectStoreKiB(gitDir: string): Promise<number> {
  const output = await simpleGit({ baseDir: gitDir, ...mirrorGitOptions() }).raw([
    '--git-dir',
    gitDir,
    'count-objects',
    '-v',
  ])
  let total = 0
  for (const line of output.split('\n')) {
    const [name, value] = line.split(': ')
    if (name === 'size' || name === 'size-pack') total += Number(value) || 0
  }
  return total
}
