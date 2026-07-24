import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

const DIST_BIN = path.resolve(__dirname, '../../dist/cli/cli.js')
const SRC_BIN = path.resolve(__dirname, './cli.ts')

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

// Both dist and source are invoked via tsx (passed as the executor in these tests).
// The dist binary uses #!/usr/bin/env node at runtime; tsx is only needed here in tests.
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
  throw new Error('tsx not found in node_modules — run "pnpm install" first')
})

const distExists = existsSync(DIST_BIN)

if (!distExists) {
  it('dist CLI tests skipped — run "pnpm build" in packages/canopycms', () => {
    expect(true).toBe(true)
  })
}

describe.skipIf(!distExists)('CLI binary execution (dist)', () => {
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
        'app/ai/config.ts',
        'app/ai/[...path]/route.ts',
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
        'app/ai/config.ts',
        'app/ai/[...path]/route.ts',
      ]

      for (const file of expectedFiles) {
        expect(await fileExists(path.join(tmpDir, file)), `Expected ${file} to exist`).toBe(true)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('defaults unchanged: non-interactive with no auth/dual-build flags yields dev auth, no dual-build', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-defaults-'))
    try {
      await execFileAsync(tsxBin, [SRC_BIN, 'init', '--non-interactive', '--force'], {
        cwd: tmpDir,
        timeout: 15_000,
      })

      const canopy = await fs.readFile(path.join(tmpDir, 'app/lib/canopy.ts'), 'utf-8')
      expect(canopy).toContain('createDevAuthPlugin')
      expect(canopy).not.toContain('createClerkAuthPlugin')

      // Dual-build off: no .server extensions, plain route/page names.
      expect(await fileExists(path.join(tmpDir, 'app/edit/page.tsx'))).toBe(true)
      expect(await fileExists(path.join(tmpDir, 'app/edit/page.server.tsx'))).toBe(false)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('runs init --non-interactive --auth clerk --force and generates clerk-flavored files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-auth-clerk-'))
    try {
      await execFileAsync(
        tsxBin,
        [SRC_BIN, 'init', '--non-interactive', '--auth', 'clerk', '--force'],
        { cwd: tmpDir, timeout: 15_000 },
      )

      const canopy = await fs.readFile(path.join(tmpDir, 'app/lib/canopy.ts'), 'utf-8')
      expect(canopy).toContain('createClerkAuthPlugin')

      const middleware = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
      expect(middleware).toContain('clerkMiddleware')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('runs init --non-interactive --auth dev --force and generates dev-only files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-auth-dev-'))
    try {
      await execFileAsync(
        tsxBin,
        [SRC_BIN, 'init', '--non-interactive', '--auth', 'dev', '--force'],
        { cwd: tmpDir, timeout: 15_000 },
      )

      const canopy = await fs.readFile(path.join(tmpDir, 'app/lib/canopy.ts'), 'utf-8')
      expect(canopy).toContain('createDevAuthPlugin')
      expect(canopy).not.toContain('createClerkAuthPlugin')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('runs init --non-interactive --dual-build --force and generates dual-build files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-dual-build-'))
    try {
      await execFileAsync(
        tsxBin,
        [SRC_BIN, 'init', '--non-interactive', '--dual-build', '--force'],
        { cwd: tmpDir, timeout: 15_000 },
      )

      const config = await fs.readFile(path.join(tmpDir, 'next.config.ts'), 'utf-8')
      expect(config).toContain('CANOPY_BUILD')

      expect(await fileExists(path.join(tmpDir, 'app/edit/page.server.tsx'))).toBe(true)
      expect(
        await fileExists(path.join(tmpDir, 'app/api/canopycms/[...canopycms]/route.server.ts')),
      ).toBe(true)
      expect(await fileExists(path.join(tmpDir, 'app/edit/page.tsx'))).toBe(false)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('exits non-zero and prints an error for an invalid --auth value', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cli-auth-invalid-'))
    try {
      await expect(
        execFileAsync(tsxBin, [SRC_BIN, 'init', '--non-interactive', '--auth', 'foo', '--force'], {
          cwd: tmpDir,
          timeout: 15_000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('--auth must be "clerk" or "dev"'),
      })
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
