import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

const DIST_BIN = path.resolve(__dirname, '../../dist/cli/init.js')
const SRC_BIN = path.resolve(__dirname, './init.ts')

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

// Both dist and source use tsx (via shebang #!/usr/bin/env tsx).
// Resolve the tsx binary — may be hoisted to monorepo root in workspaces.
let tsxBin: string

beforeAll(async () => {
  const candidates = [
    path.resolve(__dirname, '../../node_modules/.bin/tsx'),
    path.resolve(__dirname, '../../../../node_modules/.bin/tsx'),
  ]
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      tsxBin = candidate
      return
    }
  }
  throw new Error('tsx not found in node_modules — run "npm install" first')
})

describe('CLI binary execution (dist)', () => {
  beforeAll(async () => {
    if (!(await fileExists(DIST_BIN))) {
      throw new Error(
        `dist/cli/init.js not found — run "npm run build" in packages/canopycms first`,
      )
    }
  })

  it('prints help when run with no arguments', async () => {
    const { stdout } = await execFileAsync(tsxBin, [DIST_BIN], {
      timeout: 10_000,
    })
    expect(stdout).toContain('CanopyCMS CLI')
    expect(stdout).toContain('Commands:')
  })

  it('runs init --non-interactive --force and creates expected files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-dist-'))
    try {
      await execFileAsync(tsxBin, [DIST_BIN, 'init', '--non-interactive', '--force'], {
        cwd: tmpDir,
        timeout: 15_000,
      })

      const expectedFiles = [
        'canopycms.config.ts',
        'app/lib/canopy.ts',
        'app/schemas.ts',
        'app/api/canopycms/[...canopycms]/route.ts',
        'app/edit/page.tsx',
      ]

      for (const file of expectedFiles) {
        expect(await fileExists(path.join(tmpDir, file)), `Expected ${file} to exist`).toBe(true)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('CLI binary execution (source via tsx)', () => {
  it('prints help when run from source', async () => {
    const { stdout } = await execFileAsync(tsxBin, [SRC_BIN], {
      timeout: 10_000,
    })
    expect(stdout).toContain('CanopyCMS CLI')
    expect(stdout).toContain('Commands:')
  })

  it('runs init --non-interactive --force from source', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-src-'))
    try {
      await execFileAsync(tsxBin, [SRC_BIN, 'init', '--non-interactive', '--force'], {
        cwd: tmpDir,
        timeout: 15_000,
      })

      const expectedFiles = [
        'canopycms.config.ts',
        'app/lib/canopy.ts',
        'app/schemas.ts',
        'app/api/canopycms/[...canopycms]/route.ts',
        'app/edit/page.tsx',
      ]

      for (const file of expectedFiles) {
        expect(await fileExists(path.join(tmpDir, file)), `Expected ${file} to exist`).toBe(true)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
