import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Gives a test run a temp directory it owns, and deletes it when the run ends.
 *
 * Wired as vitest `globalSetup` (see `ownedTmpdirSetup` in vitest.shared.ts).
 * `setup` points TMPDIR at a fresh per-run root before any worker is spawned,
 * so `os.tmpdir()` in every test file, and in every subprocess a test starts,
 * resolves inside that root. A test that never removes its `mkdtemp` directory
 * therefore strands nothing: the whole root goes in `teardown`, which runs in
 * the main process and so still runs when a test file fails.
 *
 * Ownership rather than per-test cleanup, because cleanup is a convention every
 * new test file has to remember and this is not.
 *
 * Bound on failure: a run that never reaches teardown (Ctrl-C, SIGKILL, a
 * crash) leaves one root, and `setup` sweeps those on the next run.
 * Interruption is the common case - vitest's SIGINT handler exits without
 * running globalSetup teardown.
 */

/**
 * Prefix of a run's root; the owning pid follows it - see `sweepDeadRoots`.
 * Kept short: tsx binds a unix socket under the temp directory, and macOS caps
 * a socket path at 104 bytes with ~50 already spent on `/var/folders/.../T/`.
 */
export const RUN_TMPDIR_PREFIX = 'canopy-test-'

/** Carries the run's root to the workers, for the test asserting that `os.tmpdir()` is that root. */
export const RUN_TMPDIR_ENV = 'CANOPY_TEST_RUN_TMPDIR'

/** Every variable `os.tmpdir()` consults, POSIX and Windows. */
const TMPDIR_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

/**
 * Removes the `<prefix><pid>-*` entries of `os.tmpdir()` whose owning process
 * is gone.
 *
 * Liveness is asked of the OS rather than guessed from mtime, which cannot tell
 * a crashed run from a live one that is merely slow. Only ESRCH ("no such
 * process") licenses a delete: EPERM (alive, someone else's), a range error
 * from an absurd pid and a recycled pid reading as alive all leave the
 * directory alone, so every ambiguous case leaks one directory rather than
 * deleting a concurrent run's files out from under it.
 *
 * The one shape this gets wrong is a separate PID namespace sharing the tmpdir
 * (a container bind-mounting /tmp): a live containerized run can read as ESRCH
 * on the host. This repo's CI runs suites directly on the runner.
 */
export function sweepDeadRoots(prefix: string = RUN_TMPDIR_PREFIX): void {
  const base = os.tmpdir()
  for (const entry of readdirSync(base)) {
    if (!entry.startsWith(prefix)) continue
    const pid = Number(entry.slice(prefix.length).split('-')[0])
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0)
      continue
    } catch (error) {
      if (!isNoSuchProcess(error)) continue
    }
    try {
      rmSync(path.join(base, entry), { recursive: true, force: true })
    } catch {
      // A root we cannot remove is not worth failing an otherwise good run over.
    }
  }
}

let root: string | undefined
const previous = new Map<string, string | undefined>()

/** vitest globalSetup. */
export function setup(): void {
  // vitest runs globalSetup once per project, each with its own instance of
  // this module, so the environment is the only shared record that this
  // process already owns a root. Nesting a second one would also push tsx's
  // socket path over the limit noted on RUN_TMPDIR_PREFIX.
  const ownPrefix = `${RUN_TMPDIR_PREFIX}${process.pid}-`
  if (path.basename(os.tmpdir()).startsWith(ownPrefix)) return

  sweepDeadRoots()
  root = mkdtempSync(path.join(os.tmpdir(), ownPrefix))
  for (const name of [...TMPDIR_VARS, RUN_TMPDIR_ENV]) {
    previous.set(name, process.env[name])
    process.env[name] = root
  }
}

/** vitest globalSetup teardown. */
export function teardown(): void {
  if (!root) return
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  // Retries cover a detached `git gc` still writing into a test repository:
  // rmSync throws ENOTEMPTY when a directory gains an entry mid-removal.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Left for the next run's sweep rather than failing a run whose tests passed.
  }
  root = undefined
}
