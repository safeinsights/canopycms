/**
 * `scripts/bump-version.mjs` had no test at all, while being the thing that
 * decides what version every release publishes.
 *
 * The `--min` mode is the release train's self-heal: publish.yml commits the
 * version bump only AFTER all five packages publish, so an interrupted run
 * leaves npm holding a version main does not know about. Bumping from the
 * committed value then re-derives an already-published version and every later
 * run dies on "cannot publish over previously published version" -- forever.
 * Flooring on `npm view canopycms version` is what breaks that loop.
 *
 * The argument validation matters for a blunter reason: this script rewrites
 * six package.json files in place, so a typo'd flag used to be written verbatim
 * as the version and exit 0, surfacing only later at `npm publish`.
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

  describe('bump modes', () => {
    it('patch-bumps the committed version with no arguments', async () => {
      await seed('0.0.63')
      const { stdout } = await run([])
      expect(stdout.trim()).toBe('0.0.64')
      expect(await readVersion('packages/canopycms')).toBe('0.0.64')
    })

    it('bumps from the REGISTRY when it is ahead of the repo', async () => {
      // The wedge: an interrupted publish left npm at 0.0.70 while main still
      // says 0.0.63. Without the floor this returns 0.0.64, which already
      // exists, and every subsequent run fails identically forever.
      await seed('0.0.63')
      const { stdout } = await run(['--min', '0.0.70'])
      expect(stdout.trim()).toBe('0.0.71')
    })

    it('bumps from the REPO when it is ahead of the registry', async () => {
      await seed('0.0.63')
      const { stdout } = await run(['--min', '0.0.60'])
      expect(stdout.trim()).toBe('0.0.64')
    })

    it('applies an explicit version without bumping', async () => {
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
      await run(['--min', '0.0.70'])
      for (const pkg of PACKAGES) {
        expect(await readVersion(pkg), `${pkg} should be bumped`).toBe('0.0.71')
      }
      const root = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf-8'))
      expect(root.version).toBe('0.0.71')
    })
  })

  describe('argument validation', () => {
    /** Assert the script exits non-zero AND leaves every manifest untouched. */
    async function expectRejected(args: string[]): Promise<void> {
      await seed('0.0.63')
      await expect(run(args)).rejects.toThrow()
      for (const pkg of PACKAGES) {
        expect(await readVersion(pkg), `${pkg} must be untouched`).toBe('0.0.63')
      }
    }

    it('rejects an unknown flag instead of writing it as the version', async () => {
      // This is the real defect: `--mim 0.0.70` used to write
      // `"version": "--mim"` into six manifests and exit 0, surfacing only
      // later at `npm publish`.
      await expectRejected(['--mim', '0.0.70'])
    })

    it('rejects transposed arguments rather than silently not bumping', async () => {
      await expectRejected(['0.0.64', '--min'])
    })

    it('rejects --min with no version', async () => {
      await expectRejected(['--min'])
    })

    it('rejects a malformed explicit version', async () => {
      await expectRejected(['not-a-version'])
    })

    it('rejects a prerelease floor, which this channel cannot order', async () => {
      // Strict for --min even though the EXPLICIT form accepts a suffix: an
      // `-int.N` value has no meaningful ordering against a stable release, so
      // flooring on one would silently mis-derive the next stable version.
      await expectRejected(['--min', '0.0.64-int.3'])
    })

    it('rejects a leading-zero version, which npm treats as invalid semver', async () => {
      await expectRejected(['01.2.3'])
    })

    it('rejects a four-component version', async () => {
      await expectRejected(['1.2.3.4'])
    })
  })
})
