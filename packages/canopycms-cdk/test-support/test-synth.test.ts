import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, aws_s3 as s3 } from 'aws-cdk-lib'
import { afterEach, describe, expect, it } from 'vitest'

import { listTmpdirCdkOutEntries, newTestApp, sweepDeadRoots, testSynthRoot } from './test-synth'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(thisDir, '..')

/**
 * Directories the convention scan below does not walk, all of them generated
 * output rather than our sources.
 *
 * Dot-directories cover `.scaffold-synth/`, which holds the throwaway projects
 * scaffold-synth.test.ts builds; `cdk.out` covers what the canary's own
 * documented `npx cdk synth` workflow writes. The CDK apps inside both
 * legitimately construct an App, so scanning them would misreport generated
 * code as an offender -- and, for `.scaffold-synth/`, make this scan depend on
 * whether that suite happened to run first.
 */
const UNSCANNED_DIRS = new Set(['node_modules', 'dist', 'cdk.out'])

/**
 * The files allowed to construct a CDK App directly: this suite's helper, and
 * the canary's deployable entrypoint.
 *
 * An allowlist rather than skipping `canary/` wholesale, which is what this
 * replaced: that directory is exempt only because of the one entrypoint in it,
 * and skipping the whole tree would silently exempt any test file added there
 * later.
 */
const ALLOWED_TO_CONSTRUCT = new Set([
  path.join(thisDir, 'test-synth.ts'),
  path.join(packageRoot, 'canary', 'bin', 'canary.ts'),
])

/**
 * Matches a direct App construction, including the namespace-qualified form
 * CDK's own docs use.
 *
 * Linear despite the nested quantifier: `[\w$]` excludes `.`, so each
 * repetition of the group must terminate at a literal `.` and the
 * decomposition of any input is unique.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- see linearity note above
const APP_CONSTRUCTION = /\bnew\s+(?:[\w$]+\.)*App\s*\(/

/**
 * Matches a Stack construction given no usable scope, which reintroduces this
 * very leak by a second route: CDK's Stack constructor builds its own App with
 * no `outdir` when the scope is absent, and that App temp-dirs into
 * `os.tmpdir()` exactly as the original bug did. The App pattern cannot see it,
 * because the text never names App at all.
 *
 * Same linearity argument as above.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- see linearity note above
const SCOPELESS_STACK = /\bnew\s+(?:[\w$]+\.)*Stack\s*\(\s*(?:\)|undefined|null)/

/** Every .ts/.tsx/.mts/.cts file in the package, so neither a new subdirectory nor a new extension slips past. */
function walkTypeScriptFiles(dir: string): string[] {
  // withFileTypes rather than a statSync per entry: it does not follow
  // symlinks, so a dangling one under the package cannot abort the walk with a
  // bare ENOENT pointing at a stat call instead of at this rule.
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (UNSCANNED_DIRS.has(entry.name) || entry.name.startsWith('.')) return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walkTypeScriptFiles(full)
    return entry.isFile() && /\.(?:m|c)?tsx?$/.test(full) ? [full] : []
  })
}

describe('test synth output is confined to a directory the suite owns', () => {
  it('a synth leaves no new cdk.out* directory behind in os.tmpdir()', () => {
    const before = listTmpdirCdkOutEntries()

    const app = newTestApp()
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    new s3.Bucket(stack, 'Bucket')
    const assembly = app.synth()

    // The headline claim, asserted first so that a regression fails for the
    // reason this test is named after. Differenced against the snapshot rather
    // than compared to zero: another CDK process sharing the same tmpdir owns
    // its own entries, and only the ones THIS synth added are ours to fail on.
    //
    // Narrow on purpose -- it covers this one synth. The same property is
    // enforced across every test file by synth-leak-guard.ts.
    const after = listTmpdirCdkOutEntries()
    expect([...after].filter((entry) => !before.has(entry))).toEqual([])

    // Non-vacuity, and the whole reason this test is not just an assertion
    // about an empty set: prove a REAL synth was written to disk, and written
    // inside this run's root. Without these two, the assertion above would
    // pass just as happily if the synth had silently done nothing at all.
    // Deliberately AFTER it -- ordered first, these fire first under the very
    // mutation (dropping `outdir`) that is supposed to prove the leak
    // assertion works, masking the assertion they exist to support.
    expect(assembly.directory.startsWith(testSynthRoot())).toBe(true)
    expect(existsSync(path.join(assembly.directory, 'TestStack.template.json'))).toBe(true)
  })

  it('newTestApp is the only place the package constructs a CDK App or a scope-less Stack', () => {
    // A CONVENTION check, not the leak guarantee -- keep the distinction, since
    // treating this as the guarantee is what left four test files unprotected
    // for two review rounds. The guarantee is behavioral and lives in
    // synth-leak-guard.ts, which wraps every file and catches a leak whatever
    // route produced it. This test adds something that hook cannot: it fails on
    // a direct construction even in a file whose leak would only manifest
    // conditionally, or that no run happens to exercise.
    //
    // Being textual, it has blind spots by construction -- a `Stack` subclass,
    // or a scope passed as a variable that is sometimes undefined. Do not widen
    // the patterns to chase those; that is the behavioral hook's job.
    //
    // The scan would also match its own patterns written out in prose, which is
    // why the comments here describe the idioms instead of spelling them, and
    // why the files legitimately holding one are allowlisted by path.
    const files = walkTypeScriptFiles(packageRoot).filter((f) => !ALLOWED_TO_CONSTRUCT.has(f))

    // Non-vacuity: a walk that silently returned nothing would pass forever,
    // and so would one that quietly stopped reaching the suites that matter.
    expect(files.length).toBeGreaterThan(5)
    expect(files).toContain(path.join(packageRoot, 'src', 'constructs', 'cms-deploy.test.ts'))
    expect(files).toContain(path.join(packageRoot, 'lambda', 'asset-transform', 'handler.test.ts'))
    expect(files).toContain(path.join(packageRoot, 'src', 'scaffold-synth.test.ts'))

    const offenders = files.filter((f) => {
      const source = readFileSync(f, 'utf8')
      return APP_CONSTRUCTION.test(source) || SCOPELESS_STACK.test(source)
    })
    expect(offenders.map((f) => path.relative(packageRoot, f))).toEqual([])
  })
})

describe('roots left by interrupted runs are swept, live ones are not', () => {
  const created: string[] = []

  /** A root named as if owned by `pid`, holding a subdirectory so an errant delete is visible. */
  function plantRoot(pid: number): string {
    const root = mkdtempSync(path.join(os.tmpdir(), `canopycms-cdk-synth-${pid}-`))
    mkdtempSync(path.join(root, 'app-'))
    created.push(root)
    return root
  }

  afterEach(() => {
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('removes a root whose owning process is gone', () => {
    // A pid that has certainly exited: spawnSync returns only after the child
    // is reaped, so this is a dead pid rather than a guess at an unused number.
    // If the OS recycled it onto a live process between here and the sweep this
    // goes RED, never falsely green -- worth knowing if it ever fails oddly.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    expect(deadPid).toBeGreaterThan(0)
    const root = plantRoot(deadPid as number)

    sweepDeadRoots()

    expect(existsSync(root)).toBe(false)
  })

  it('leaves a root whose owning process is still alive', () => {
    // The safety-critical half. Getting this wrong deletes a concurrent run's
    // assemblies mid-flight, which is worse than the leak being fixed here --
    // and it is why the root carries a pid instead of being age-gated.
    const root = plantRoot(process.pid)

    sweepDeadRoots()

    expect(existsSync(root)).toBe(true)
  })

  it('leaves a root it cannot attribute to any process', () => {
    // Nothing in the name to check liveness against, so it must not be touched.
    const root = mkdtempSync(path.join(os.tmpdir(), 'canopycms-cdk-synth-notapid-'))
    created.push(root)

    sweepDeadRoots()

    expect(existsSync(root)).toBe(true)
  })
})
