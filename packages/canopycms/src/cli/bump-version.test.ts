/**
 * `scripts/bump-version.mjs` decides what version every release publishes, so
 * it takes exactly one explicit version and rejects everything else: this
 * script rewrites six package.json files in place, so a typo'd flag must fail
 * rather than be written as the version and surface only at `npm publish`.
 *
 * Driven as a subprocess rather than by import, because the script does its
 * work at module scope against a directory tree.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

// This file sits at packages/canopycms/src/cli/, so the workspace root is four up.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', '..', 'scripts')
const SCRIPT = path.join(SCRIPTS_DIR, 'bump-version.mjs')
const PRERELEASE_SCRIPT = path.join(SCRIPTS_DIR, 'prerelease-version.mjs')

/** The five publishable packages the script rewrites, plus the root manifest. */
const PACKAGES = [
  'packages/canopycms',
  'packages/canopycms-next',
  'packages/canopycms-auth-clerk',
  'packages/canopycms-auth-dev',
  'packages/canopycms-cdk',
]

/** The generated constant the script rewrites alongside the manifests. */
const VERSION_FILE = (root: string): string =>
  path.join(root, 'packages', 'canopycms', 'src', 'version.ts')

describe('scripts/bump-version.mjs', () => {
  let tmpDir: string

  /** A minimal workspace tree shaped the way the script expects. */
  async function seed(version: string): Promise<void> {
    for (const pkg of PACKAGES) {
      const dir = path.join(tmpDir, pkg)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: path.basename(pkg), version }, null, 2) + '\n',
      )
    }
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'root', version }, null, 2) + '\n',
    )
    await fs.mkdir(path.dirname(VERSION_FILE(tmpDir)), { recursive: true })
    await fs.writeFile(VERSION_FILE(tmpDir), `export const CANOPYCMS_VERSION = '${version}'\n`)
  }

  /**
   * Run the script against the fixture tree. The script resolves paths from its
   * OWN location, so it is copied in rather than invoked in place.
   */
  async function run(args: string[]): Promise<{ stdout: string }> {
    const localScript = path.join(tmpDir, 'scripts', 'bump-version.mjs')
    return execFileAsync(process.execPath, [localScript, ...args], { cwd: tmpDir })
  }

  const readVersion = async (pkg: string): Promise<string> =>
    JSON.parse(await fs.readFile(path.join(tmpDir, pkg, 'package.json'), 'utf-8')).version

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-bump-version-'))
    await fs.mkdir(path.join(tmpDir, 'scripts'), { recursive: true })
    await fs.copyFile(SCRIPT, path.join(tmpDir, 'scripts', 'bump-version.mjs'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('writing the version', () => {
    it('writes the explicit version as given', async () => {
      await seed('0.0.63')
      const { stdout } = await run(['1.2.3'])
      expect(stdout.trim()).toBe('1.2.3')
    })

    it('accepts EXACTLY what the prerelease channel feeds it', async () => {
      // This test exists because its predecessor did not. It asserted the
      // "prerelease path" using a plain `1.2.3`, so when stricter validation
      // was added it stayed green while publish-prerelease.yml -- which passes
      // `prerelease-version.mjs`'s `X.Y.Z-int.N` output straight through --
      // began failing at "Apply prerelease version" on every dispatch.
      //
      // The input is DERIVED from the real script rather than hard-coded, so
      // the two cannot drift apart again.
      const { stdout: generated } = await execFileAsync(process.execPath, [
        PRERELEASE_SCRIPT,
        '0.0.63',
        '123',
      ])
      const prereleaseVersion = generated.trim()
      expect(prereleaseVersion).toMatch(/^\d+\.\d+\.\d+-int\.\d+$/)

      await seed('0.0.63')
      const { stdout } = await run([prereleaseVersion])
      expect(stdout.trim()).toBe(prereleaseVersion)
      expect(await readVersion('packages/canopycms')).toBe(prereleaseVersion)
    })

    it('trims an explicit version rather than writing the untrimmed original', async () => {
      // The validated string and the written string must be the same one:
      // validating `value.trim()` while writing `value` put a leading space
      // into six manifests and exited 0.
      await seed('0.0.63')
      const { stdout } = await run([' 1.2.3'])
      expect(stdout.trim()).toBe('1.2.3')
      expect(await readVersion('packages/canopycms')).toBe('1.2.3')
    })

    it('writes the new version to every publishable package and the root', async () => {
      await seed('0.0.63')
      await run(['0.0.71'])
      for (const pkg of PACKAGES) {
        expect(await readVersion(pkg), `${pkg} should be bumped`).toBe('0.0.71')
      }
      const root = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf-8'))
      expect(root.version).toBe('0.0.71')
    })

    it('rewrites the generated version constant to the new version', async () => {
      await seed('0.0.63')
      await run(['0.0.71'])
      const source = await fs.readFile(VERSION_FILE(tmpDir), 'utf-8')
      expect(source).toContain("export const CANOPYCMS_VERSION = '0.0.71'")
      expect(source).not.toContain('0.0.63')
    })

    it('generates the same file that is committed, differing only in the version', async () => {
      await seed('0.0.63')
      await run(['0.0.64'])
      const committed = await fs.readFile(path.join(__dirname, '..', 'version.ts'), 'utf-8')
      const generated = await fs.readFile(VERSION_FILE(tmpDir), 'utf-8')
      expect(generated).toBe(committed.replace(/'[^']*'/, "'0.0.64'"))
    })

    it('writes an explicit prerelease version into the constant', async () => {
      await seed('0.0.63')
      await run(['0.0.64-int.9'])
      expect(await fs.readFile(VERSION_FILE(tmpDir), 'utf-8')).toContain(
        "export const CANOPYCMS_VERSION = '0.0.64-int.9'",
      )
    })
  })

  describe('argument validation', () => {
    /**
     * Assert the script exits non-zero AND leaves every manifest untouched. The
     * optional `message` pins WHICH check rejected it (execFile folds stderr into
     * the error message).
     */
    async function expectRejected(args: string[], message?: RegExp): Promise<void> {
      await seed('0.0.63')
      await expect(run(args)).rejects.toThrow(message)
      for (const pkg of PACKAGES) {
        expect(await readVersion(pkg), `${pkg} must be untouched`).toBe('0.0.63')
      }
      expect(await fs.readFile(VERSION_FILE(tmpDir), 'utf-8')).toContain("'0.0.63'")
    }

    it('rejects no argument rather than guessing a version', async () => {
      await expectRejected([], /Missing version argument/)
    })

    it('rejects --min as an unknown option', async () => {
      await expectRejected(['--min', '0.0.70'], /Unknown option "--min"/)
    })

    it('rejects an unknown flag instead of writing it as the version', async () => {
      await expectRejected(['--mim'], /Unknown option/)
    })

    it('rejects an extra argument after the version', async () => {
      await expectRejected(['0.0.64', '0.0.65'], /Unexpected extra argument/)
    })

    it('rejects a flag after the version', async () => {
      await expectRejected(['0.0.64', '--min'], /Unknown option/)
    })

    it('rejects a malformed explicit version', async () => {
      await expectRejected(['not-a-version'])
    })

    it('rejects a leading-zero version, which npm treats as invalid semver', async () => {
      await expectRejected(['01.2.3'])
    })

    it('rejects a four-component version', async () => {
      await expectRejected(['1.2.3.4'])
    })

    it('rejects an empty argument', async () => {
      await expectRejected([''], /Empty version argument/)
    })

    // The prerelease/build suffix follows semver's identifier grammar, not a
    // loose character class -- verified to match the `semver` package exactly
    // on every strict case. A looser pattern wrote invalid semver into six
    // manifests and failed later at `npm publish`, which is the same failure
    // the numeric core's leading-zero rule exists to prevent.
    it.each([
      ['1.2.3-int.007', 'leading zero in a numeric prerelease identifier'],
      ['1.2.3-int..1', 'empty identifier'],
      ['1.2.3-.', 'empty identifier'],
      ['1.2.3-', 'empty prerelease'],
      ['1.2.3+', 'empty build metadata'],
      ['v1.2.3', 'a `v` prefix, which package.json version must not carry'],
    ])('rejects %j (%s)', async (version) => {
      await expectRejected([version])
    })

    it.each(['1.2.3-int-5', '1.2.3-0', '1.2.3-alpha.beta', '1.2.3+build.1'])(
      'accepts the valid semver %j',
      async (version) => {
        await seed('0.0.63')
        const { stdout } = await run([version])
        expect(stdout.trim()).toBe(version)
      },
    )
  })
})

describe('prerelease-version.mjs', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prerelease-version-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const prerelease = async (args: string[]): Promise<string> =>
    (await execFileAsync(process.execPath, [PRERELEASE_SCRIPT, ...args])).stdout.trim()

  const plan = async (releases: unknown[]): Promise<string> => {
    const file = path.join(dir, 'plan.json')
    await fs.writeFile(file, JSON.stringify({ changesets: [], releases }))
    return file
  }

  it('patch-bumps main without a plan', async () => {
    expect(await prerelease(['0.0.67', '115'])).toBe('0.0.68-int.115')
  })

  it("takes the plan's next canopycms version as the base, unbumped", async () => {
    const file = await plan([
      { name: 'canopycms-cdk', type: 'minor', newVersion: '0.1.0' },
      { name: 'canopycms', type: 'minor', newVersion: '0.1.0' },
    ])
    expect(await prerelease(['0.0.67', '115', '--plan', file])).toBe('0.1.0-int.115')
  })

  it('falls back to main patch-bumped when the plan releases nothing', async () => {
    // A `none` release keeps the old version, which would sort below the stable release.
    const file = await plan([{ name: 'canopycms', type: 'none', newVersion: '0.0.67' }])
    expect(await prerelease(['0.0.67', '115', '--plan', file])).toBe('0.0.68-int.115')
  })

  it('never goes below main patch-bumped', async () => {
    // An older line's manifests: its plan would sort below the stable release.
    const file = await plan([{ name: 'canopycms', type: 'patch', newVersion: '0.0.61' }])
    expect(await prerelease(['0.0.67', '115', '--plan', file])).toBe('0.0.68-int.115')
  })

  it('refuses a plan version that is not a plain release', async () => {
    const file = await plan([{ name: 'canopycms', type: 'minor', newVersion: '0.1.0-int.3' }])
    await expect(prerelease(['0.0.67', '115', '--plan', file])).rejects.toThrow(/plain version/)
  })

  it('refuses --plan without a file', async () => {
    await expect(prerelease(['0.0.67', '115', '--plan'])).rejects.toThrow(/Usage/)
  })
})
