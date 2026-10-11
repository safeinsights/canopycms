import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { getErrorMessage } from '../utils/error'

/**
 * Upkeep of the GitHub gateway's private mirror (worker/github-mirror.ts): what a killed process
 * leaves in it, damage that would make it lie, and the maintenance that keeps it fast. Everything
 * here touches only the gateway's own state directory.
 *
 * Two locks order every writer of the mirror, always taken in this order: a mirror session
 * (`GitHubMirror.exclusive`), then the {@link MaintenanceMutex}. Maintenance takes only the mutex,
 * so it runs beside sessions; a session takes the mutex only to sweep (never waiting for it) or
 * to rebuild (waiting, since a rebuild swaps the repository out from under maintenance). A sweep
 * the mutex prevents is owed, and done at the next session's start that can take it.
 */

/** A lock that maintenance holds for its whole run; see the module doc for the order. */
export class MaintenanceMutex {
  private held: Promise<void> | null = null

  /** Take it now, or get null when it is held. */
  tryAcquire(): (() => void) | null {
    if (this.held !== null) return null
    let release!: () => void
    this.held = new Promise<void>((resolve) => {
      release = () => {
        this.held = null
        resolve()
      }
    })
    return release
  }

  /** Take it, waiting for a holder to let go. */
  async acquire(): Promise<() => void> {
    for (;;) {
      const release = this.tryAcquire()
      if (release !== null) return release
      await this.held
    }
  }
}

/** Where a rebuild fetches the replacement, and where the swap parks the old mirror. */
export function rebuildPaths(gitDir: string): { rebuild: string; old: string } {
  return { rebuild: `${gitDir}.rebuild`, old: `${gitDir}.old` }
}

/**
 * Finish or undo a rebuild a crash interrupted. The swap renames the mirror to `.old`, then
 * `.rebuild` into its place, then deletes `.old`, and begins only once `.rebuild` is complete. So
 * a missing mirror with `.rebuild` present means `.rebuild` is the good one; with only `.old`
 * present (which the sequence cannot leave), `.old` comes back and the corruption check decides.
 * Any other leftover goes.
 */
export async function recoverRebuild(gitDir: string): Promise<void> {
  const { rebuild, old } = rebuildPaths(gitDir)
  if (!(await exists(gitDir))) {
    if (await exists(rebuild)) await fs.rename(rebuild, gitDir)
    else if (await exists(old)) await fs.rename(old, gitDir)
  }
  await fs.rm(rebuild, { recursive: true, force: true })
  await fs.rm(old, { recursive: true, force: true })
}

/**
 * Delete every lock and temporary a killed git leaves in the mirror: ref locks
 * (`refs/**`, `packed-refs.lock`, `HEAD.lock`, `config.lock`, `shallow.lock`), `packed-refs.new`,
 * pack temporaries (`tmp_*`, repack's `.tmp-*`), fetch's `pack-*.keep`, loose `tmp_obj_*`, and
 * commit-graph locks and temporaries. Only for a mirror nothing else is writing: at start, or
 * holding the maintenance mutex inside a session. A leftover `refs/heads/<x>.lock` or
 * `packed-refs.new` fails every later fetch that touches that ref.
 */
export async function sweepLocksAndTemporaries(gitDir: string): Promise<string[]> {
  const removed: string[] = []
  const remove = async (file: string) => {
    await fs.rm(file, { recursive: true, force: true })
    removed.push(path.relative(gitDir, file))
  }
  for (const entry of await list(gitDir)) {
    if (entry.isFile() && (entry.name.endsWith('.lock') || entry.name === 'packed-refs.new')) {
      await remove(path.join(gitDir, entry.name))
    }
  }
  await walk(path.join(gitDir, 'refs'), async (file) => {
    if (file.endsWith('.lock')) await remove(file)
  })
  for (const fanout of await list(path.join(gitDir, 'objects'))) {
    if (!/^[0-9a-f]{2}$/.test(fanout.name) || !fanout.isDirectory()) continue
    const dir = path.join(gitDir, 'objects', fanout.name)
    for (const entry of await list(dir)) {
      if (entry.name.startsWith('tmp_obj_')) await remove(path.join(dir, entry.name))
    }
  }
  const packDir = path.join(gitDir, 'objects', 'pack')
  for (const entry of await list(packDir)) {
    const name = entry.name
    if (
      name.startsWith('tmp_') ||
      name.startsWith('.tmp-') ||
      name.endsWith('.keep') ||
      name.endsWith('.lock')
    ) {
      await remove(path.join(packDir, name))
    }
  }
  const infoDir = path.join(gitDir, 'objects', 'info')
  for (const entry of await list(infoDir)) {
    if (entry.name.endsWith('.lock') || entry.name.startsWith('tmp_')) {
      await remove(path.join(infoDir, entry.name))
    }
  }
  const graphs = path.join(infoDir, 'commit-graphs')
  for (const entry of await list(graphs)) {
    if (entry.name.endsWith('.lock') || entry.name.startsWith('tmp_')) {
      await remove(path.join(graphs, entry.name))
    }
  }
  return removed
}

/** What a corruption check found, or null. */
export type MirrorCorruption = string | null

/**
 * Whether the mirror has state that makes it lie about GitHub, that no GitHub fetch writes, or
 * that git cannot read: a loose `refs/heads/*` file that is not a ref (a crash can leave one
 * empty, which `for-each-ref` skips with only a warning), a `refs/heads/*` whose object is
 * missing (which `rev-parse --is-bare-repository` cannot see), a `*.promisor` pack,
 * `extensions.partialClone`, a `remote.*.promisor` / `remote.*.partialclonefilter` key in the
 * mirror's own config (read with `--get-regexp`, never `config --list`, which would print a
 * credential's value), or any git here failing (a truncated `packed-refs` fails every one). Each
 * is repaired by a rebuild. `git(args, stdin?)` runs git in the mirror under its pins.
 */
export async function findCorruption(
  gitDir: string,
  git: (args: string[], stdin?: string) => Promise<string>,
): Promise<MirrorCorruption> {
  for (const entry of await list(path.join(gitDir, 'objects', 'pack'))) {
    if (entry.name.endsWith('.promisor')) return `it holds a promisor pack (${entry.name})`
  }
  const broken: string[] = []
  await walk(path.join(gitDir, 'refs', 'heads'), async (file) => {
    if (file.endsWith('.lock')) return
    const content = (await fs.readFile(file, 'utf8').catch(() => '')).trim()
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(content) && !content.startsWith('ref: refs/')) {
      broken.push(path.relative(gitDir, file))
    }
  })
  if (broken.length > 0) return `${broken[0]} is not a ref`
  try {
    return await checkWithGit(git)
  } catch (err) {
    return `git cannot read it (${getErrorMessage(err).trim().split('\n')[0].slice(0, 200)})`
  }
}

async function checkWithGit(
  git: (args: string[], stdin?: string) => Promise<string>,
): Promise<MirrorCorruption> {
  const promisorKeys = await git([
    'config',
    '--local',
    '--get-regexp',
    '--end-of-options',
    '^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$',
  ]).catch((err: unknown) => {
    // Exit 1: no key matched.
    if (/exited with code 1$/.test(getErrorMessage(err).trim())) return ''
    throw err
  })
  const key = promisorKeys.split('\n').find(Boolean)
  if (key !== undefined) return `its config holds ${key.split(' ')[0]}`
  const heads = (
    await git([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      '--end-of-options',
      'refs/heads/',
    ])
  )
    .split('\n')
    .filter(Boolean)
  if (heads.length === 0) return null
  const lines = (
    await git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)', '--end-of-options'],
      heads.map((line) => `${line.split(' ')[0]}\n`).join(''),
    )
  ).split('\n')
  for (const [i, head] of heads.entries()) {
    if (!/ commit$/.test(lines[i] ?? '')) return `${head.split(' ')[1]} names a missing object`
  }
  return null
}

/** Above either count, maintenance repacks: the same thresholds as remote.git's. */
const MAX_LOOSE_OBJECTS = 50
const MAX_PACKS = 6

/** The wall-clock bound on each maintenance step, none of which writes anything while it works. */
const MAINTENANCE_STEP_DEADLINE_MS = 30 * 60 * 1000

/**
 * One maintenance run, holding the maintenance mutex: `repack -a -d --cruft` when the mirror
 * holds more than {@link MAX_LOOSE_OBJECTS} loose objects or {@link MAX_PACKS} packs, then
 * `commit-graph write --reachable`, then `pack-refs --all` last. A repack expires no cruft, so no
 * object a session or a quarantine is reading disappears, and a reader holding a pack the repack
 * unlinked keeps reading it. A step killed at its deadline leaves temporaries no name tells from
 * a concurrent fetch's, so the caller owes a sweep rather than removing them here.
 */
export async function maintainMirror(
  run: (args: string[], options: { deadlineMs: number }) => Promise<string>,
): Promise<{ repacked: boolean }> {
  const step = (args: string[]) => run(args, { deadlineMs: MAINTENANCE_STEP_DEADLINE_MS })
  const counts = await step(['count-objects', '-v', '--end-of-options'])
  const field = (name: string) => {
    const line = counts.split('\n').find((l) => l.startsWith(`${name}: `))
    return Number(line?.slice(name.length + 2) ?? 0)
  }
  const repack = field('count') > MAX_LOOSE_OBJECTS || field('packs') > MAX_PACKS
  if (repack) await step(['repack', '-a', '-d', '--cruft', '-q', '--end-of-options'])
  await step(['commit-graph', 'write', '--reachable', '--end-of-options'])
  await step(['pack-refs', '--all', '--end-of-options'])
  return { repacked: repack }
}

/** The mirror's object store, in KiB, for the size warning. */
export async function objectStoreKiB(run: (args: string[]) => Promise<string>): Promise<number> {
  const output = await run(['count-objects', '-v', '--end-of-options'])
  let total = 0
  for (const line of output.split('\n')) {
    const [name, value] = line.split(': ')
    if (name === 'size' || name === 'size-pack') total += Number(value) || 0
  }
  return total
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  )
}

async function list(dir: string): Promise<Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [])
}

async function walk(dir: string, visit: (file: string) => Promise<void>): Promise<void> {
  for (const entry of await list(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, visit)
    else await visit(full)
  }
}
