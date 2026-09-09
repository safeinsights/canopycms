import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, aws_s3 as s3 } from 'aws-cdk-lib'
import { afterEach, describe, expect, it } from 'vitest'

import { listTmpdirCdkOutEntries, newTestApp, sweepDeadRoots, testSynthRoot } from './test-synth'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(thisDir, '..')

/**
 * Directories the guard below does not walk.
 *
 * Dot-directories are skipped because they are generated working state, not our
 * sources: `.scaffold-synth/` holds the throwaway projects
 * scaffold-synth.test.ts builds, and the CDK app IT generates legitimately
 * constructs an App. Scanning those would both misreport generated code as an
 * offender and make this guard depend on whether that suite happened to run
 * first.
 */
const UNSCANNED_DIRS = new Set(['node_modules', 'dist'])

/**
 * The two files allowed to construct a CDK App directly.
 *
 * An allowlist rather than skipping `canary/` wholesale: that directory is
 * exempt only because of the one deployable entrypoint in it, and skipping the
 * whole tree would silently exempt any test file added there later.
 */
const ALLOWED_TO_CONSTRUCT = new Set([
  path.join(thisDir, 'test-synth.ts'),
  path.join(packageRoot, 'canary', 'bin', 'canary.ts'),
])

/** Matches a direct App construction, including the namespace-qualified form CDK's own docs use. */
const APP_CONSTRUCTION = /\bnew\s+(?:[\w$]+\.)*App\s*\(/

/**
 * Matches a scope-less Stack construction, which reintroduces this very leak by
 * a second route: CDK's Stack constructor falls back to building its own App
 * with no `outdir` when given no scope, and that App temp-dirs into
 * `os.tmpdir()` exactly as the original bug did. The App pattern above cannot
 * see it, because the text never names App at all.
 */
const SCOPELESS_STACK = /\bnew\s+(?:[\w$]+\.)*Stack\s*\(\s*\)/

/** Every .ts/.tsx/.mts/.cts file in the package, so neither a new subdirectory nor a new extension slips past. */
function walkTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (UNSCANNED_DIRS.has(entry) || entry.startsWith('.')) return []
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return walkTypeScriptFiles(full)
    return /\.(?:m|c)?tsx?$/.test(full) ? [full] : []
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
    // The assertion above only protects Apps that go through newTestApp. This
    // is what keeps a future direct construction -- which would silently start
    // leaking again -- from being added beside it.
    //
    // Note the scan is textual, so it would also match its own patterns written
    // out in prose. That is why the comments here describe the idioms instead
    // of spelling them, and why the files legitimately holding one are
    // allowlisted by path rather than matched around.
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

  /** A root named as if owned by `pid`, holding a file so an errant delete is visible. */
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
