import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { App } from 'aws-cdk-lib'
import type { AppProps } from 'aws-cdk-lib'

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
 * Bound on failure: a run killed hard enough to skip teardown (SIGKILL, a
 * host crash) leaves behind exactly one root, not one per synth. The
 * `find "$TMPDIR" -maxdepth 1 -name 'canopycms-cdk-synth-*' -mmin +60` shape
 * mops those up; nothing sweeps them automatically, deliberately, since one
 * run deleting another concurrent run's root would break the live one.
 */

/**
 * Carries the per-run root from `globalSetup` (main process) to the workers
 * that run the tests. Workers are spawned after `setup()` returns, so they
 * inherit it through the environment.
 */
export const TEST_SYNTH_ROOT_ENV = 'CANOPYCMS_CDK_TEST_SYNTH_ROOT'

/** Prefix CDK itself uses for the temp assemblies this module exists to prevent. */
const LEAKED_ASSEMBLY_PREFIX = 'cdk.out'

/** Prefix for the root this suite owns. Deliberately NOT `cdk.out*`, so the leak assertion cannot match our own root. */
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

/** vitest globalSetup. */
export function setup(): void {
  process.env[TEST_SYNTH_ROOT_ENV] = mkdtempSync(path.join(os.tmpdir(), SYNTH_ROOT_PREFIX))
}

/** vitest globalSetup teardown. */
export function teardown(): void {
  const root = process.env[TEST_SYNTH_ROOT_ENV]
  if (!root) return
  rmSync(root, { recursive: true, force: true })
  delete process.env[TEST_SYNTH_ROOT_ENV]
}
