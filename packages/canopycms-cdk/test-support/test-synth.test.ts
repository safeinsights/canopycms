import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, aws_s3 as s3 } from 'aws-cdk-lib'
import { describe, expect, it } from 'vitest'

import { listTmpdirCdkOutEntries, newTestApp, testSynthRoot } from './test-synth'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(thisDir, '..')

/**
 * Directories the App guard below does not walk.
 *
 * `canary/` is the one committed place in this package that constructs a real
 * CDK app -- it is a deployable app, not a test. Dot-directories are skipped
 * because they are generated working state, not our sources: `.scaffold-synth/`
 * holds the throwaway projects scaffold-synth.test.ts builds, and the CDK app
 * IT generates legitimately constructs an App. Scanning those would both
 * misreport generated code as an offender and make this guard depend on
 * whether that suite happened to run first.
 */
const UNSCANNED_DIRS = new Set(['node_modules', 'dist', 'canary'])

/** Every committed .ts file in the package, so a new subdirectory cannot slip past the guard. */
function walkTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (UNSCANNED_DIRS.has(entry) || entry.startsWith('.')) return []
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return walkTypeScriptFiles(full)
    return full.endsWith('.ts') ? [full] : []
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
    // than compared to zero: a concurrent CDK process elsewhere on the machine
    // owns its own entries, and only the ones THIS synth added are ours to
    // fail on.
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

  it('newTestApp is the only place the package tests construct a CDK App', () => {
    // The assertion above only protects Apps that go through newTestApp. This
    // is what keeps a future bare App construction -- which would silently
    // start leaking again -- from being added beside it.
    //
    // Note the scan is textual, so it also matches the pattern written out in
    // prose. That is why the sentence above paraphrases it, and why the helper
    // (whose whole job is to hold the one real call) is excluded by path.
    const helper = path.join(thisDir, 'test-synth.ts')
    const files = walkTypeScriptFiles(packageRoot).filter((f) => f !== helper)

    // Non-vacuity: a walk that silently returned nothing would pass forever.
    expect(files.length).toBeGreaterThan(5)
    expect(files).toContain(path.join(packageRoot, 'src', 'constructs', 'cms-deploy.test.ts'))
    expect(files).toContain(path.join(packageRoot, 'lambda', 'asset-transform', 'handler.test.ts'))

    const offenders = files.filter((f) => /new App\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => path.relative(packageRoot, f))).toEqual([])
  })
})
