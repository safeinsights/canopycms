import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { App } from 'aws-cdk-lib'
import type { AppProps } from 'aws-cdk-lib'
import { sweepDeadRoots as sweepDeadRootsWithPrefix } from '../../../vitest.tmpdir'

/**
 * The suite's synth-output ownership, in one file.
 *
 * A CDK `App` given no `outdir` synthesizes into a `mkdtemp('cdk.out')` under
 * `os.tmpdir()`. CDK cleans those up from a `process.on('exit')` handler
 * (`determineOutputDirectory` in `@aws-cdk/cloud-assembly-api`), but a vitest
 * worker is torn down without firing exit handlers, so that never runs here. An
 * `outdir` sidesteps the question entirely.
 *
 * Two halves, both required:
 *
 *  - `setup`/`teardown` are vitest's `globalSetup` (wired in vitest.config.ts),
 *    creating ONE root per run and deleting it afterwards. They run in the main
 *    process, so teardown still happens when an individual test file fails --
 *    which a per-file `afterAll` does not guarantee.
 *  - `newTestApp` is the ONLY place the suite may call `new App()`, enforced by
 *    a test in test-synth.test.ts. Every App gets its own subdirectory of that
 *    root: several tests build more than one App/Stack and a few compare two
 *    synths, which one shared outdir would cross-contaminate.
 */

/**
 * Carries the per-run root from `globalSetup` (main process) to the workers,
 * which are spawned after `setup()` returns and so inherit it.
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
 * `outdir` is not overridable -- the point of routing every App through here is
 * that no call site can opt out -- and `Omit` makes passing one a compile error
 * rather than an argument silently dropped, the same stance `testSynthRoot`
 * takes on a missing root. `props` is otherwise supported so that a test
 * needing App context has no reason to construct an App itself and reintroduce
 * the leak.
 */
export function newTestApp(props: Omit<AppProps, 'outdir'> = {}): App {
  // The root is recreated if it has gone missing (a cleared $TMPDIR mid-run):
  // mkdtempSync does not create parents, so without this every subsequent test
  // fails with a bare ENOENT naming a temp path rather than anything actionable.
  mkdirSync(testSynthRoot(), { recursive: true })
  return new App({ ...props, outdir: mkdtempSync(path.join(testSynthRoot(), 'app-')) })
}

/**
 * Removes roots belonging to runs that are no longer alive; the liveness rule
 * is `sweepDeadRoots` in vitest.tmpdir.ts.
 */
export function sweepDeadRoots(): void {
  sweepDeadRootsWithPrefix(SYNTH_ROOT_PREFIX)
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
