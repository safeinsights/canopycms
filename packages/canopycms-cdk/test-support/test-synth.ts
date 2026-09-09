import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { App } from 'aws-cdk-lib'
import type { AppProps } from 'aws-cdk-lib'
// Test-only import across the package boundary, as cms-deploy.test.ts already
// does. `utils/error.ts` is dependency-free.
import { isNodeError } from '../../canopycms/src/utils/error'

/**
 * The suite's synth-output ownership, in one file.
 *
 * A CDK `App` given no `outdir` synthesizes into a `mkdtemp('cdk.out')` under
 * `os.tmpdir()` that it NEVER removes. This suite constructs an `App` per
 * helper call and most of its tests synth, so at ~1-3 MB per cloud assembly it
 * was leaking a few hundred megabytes per full run. Left alone it accumulates:
 * 26,537 orphaned `cdk.out*` directories totalling 13 GB built up over eight
 * days of ordinary development before this was caught, exhausting free disk.
 * Worth knowing why that took eight days -- a full temp filesystem breaks
 * unrelated tooling, so the symptom surfaces nowhere near this cause.
 *
 * Two halves, both required:
 *
 *  - `setup`/`teardown` are vitest's `globalSetup` (wired in vitest.config.ts).
 *    They create ONE root per run and delete it afterwards. This lives in the
 *    main process, not in the test workers, so teardown still runs when an
 *    individual test file fails -- which a per-file `afterAll` does not
 *    guarantee.
 *  - `newTestApp` is the ONLY place the suite may call `new App()`, enforced by
 *    a test in test-synth.test.ts. It puts every App in its own subdirectory of
 *    that root, because several tests build more than one App/Stack and a few
 *    compare two synths against each other -- sharing one outdir between them
 *    would cross-contaminate the assemblies.
 *
 * Bound on failure: a run that never reaches teardown (Ctrl-C, SIGKILL, a host
 * crash) leaves behind one root, not one per synth -- and `setup` sweeps those
 * on the next run. Interruption is the common case, not the exotic one: Ctrl-C
 * during `vitest run` is how a developer escapes a slow suite, and vitest's
 * SIGINT handler exits without running globalSetup teardown.
 */

/**
 * Carries the per-run root from `globalSetup` (main process) to the workers
 * that run the tests. Workers are spawned after `setup()` returns, so they
 * inherit it through the environment.
 */
export const TEST_SYNTH_ROOT_ENV = 'CANOPYCMS_CDK_TEST_SYNTH_ROOT'

/** Prefix CDK itself uses for the temp assemblies this module exists to prevent. */
const LEAKED_ASSEMBLY_PREFIX = 'cdk.out'

/**
 * Prefix for the roots this suite owns. Deliberately NOT `cdk.out*`, so the
 * leak assertion cannot match our own root. A root's name carries the pid of
 * the run that owns it -- see `sweepDeadRoots`.
 */
const SYNTH_ROOT_PREFIX = 'canopycms-cdk-synth-'

/**
 * The `cdk.out*` entries currently in `os.tmpdir()`.
 *
 * Returned as a set for before/after differencing rather than as a count:
 * other processes sharing the same tmpdir (another worktree's suite, a real
 * `cdk` invocation) may add or remove their own entries while a test runs, and
 * an absolute count would make that our failure.
 */
export function listTmpdirCdkOutEntries(): Set<string> {
  return new Set(readdirSync(os.tmpdir()).filter((e) => e.startsWith(LEAKED_ASSEMBLY_PREFIX)))
}

/** The root this run owns. Throws rather than falling back, since a silent fallback is the bug itself. */
export function testSynthRoot(): string {
  const root = process.env[TEST_SYNTH_ROOT_ENV]
  if (!root) {
    throw new Error(
      `${TEST_SYNTH_ROOT_ENV} is not set: this suite's synth root is created by the ` +
        `globalSetup in packages/canopycms-cdk/vitest.config.ts. Run these tests through ` +
        `that config (\`pnpm --filter canopycms-cdk test\`) rather than a bare vitest.`,
    )
  }
  return root
}

/**
 * A CDK `App` that synthesizes inside this run's root instead of leaking a
 * cloud assembly into `os.tmpdir()`.
 *
 * `outdir` is applied after `props` on purpose: it is not overridable, because
 * the point of routing every App through here is that no call site can opt out.
 * `props` is supported so that a test needing App context has no reason to
 * reach for a bare `new App()` and reintroduce the leak.
 */
export function newTestApp(props: AppProps = {}): App {
  return new App({ ...props, outdir: mkdtempSync(path.join(testSynthRoot(), 'app-')) })
}

/**
 * Removes roots belonging to runs that are no longer alive.
 *
 * Sweeping has to tell a dead run's root from a CONCURRENT live one's, and
 * getting that wrong deletes a running suite's assemblies out from under it.
 * That hazard is why the root name carries its owner's pid: liveness is asked
 * of the OS rather than guessed from mtime, which cannot distinguish a crashed
 * run from a live one that is simply slow between synths.
 *
 * Only ESRCH ("no such process") licenses a delete. EPERM means the pid is
 * alive but owned by another user, and a recycled pid reads as alive too --
 * both leave the directory alone. Every ambiguous case errs toward leaking one
 * directory rather than breaking a live run.
 */
export function sweepDeadRoots(): void {
  for (const entry of readdirSync(os.tmpdir())) {
    if (!entry.startsWith(SYNTH_ROOT_PREFIX)) continue
    const pid = Number(entry.slice(SYNTH_ROOT_PREFIX.length).split('-')[0])
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0)
      continue
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ESRCH') continue
    }
    try {
      rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true })
    } catch {
      // A root we cannot remove is not worth failing an otherwise good run over.
    }
  }
}

/** vitest globalSetup. */
export function setup(): void {
  sweepDeadRoots()
  process.env[TEST_SYNTH_ROOT_ENV] = mkdtempSync(
    path.join(os.tmpdir(), `${SYNTH_ROOT_PREFIX}${process.pid}-`),
  )
}

/** vitest globalSetup teardown. */
export function teardown(): void {
  const root = process.env[TEST_SYNTH_ROOT_ENV]
  if (!root) return
  rmSync(root, { recursive: true, force: true })
  delete process.env[TEST_SYNTH_ROOT_ENV]
}
