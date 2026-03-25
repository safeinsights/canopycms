import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { init, initDeployAws } from './init'
import { mockConsole } from '../test-utils/console-spy'

// Mock @clack/prompts to avoid interactive prompts in tests
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: {
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  confirm: vi.fn().mockResolvedValue(false),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}))

function defaultOpts(tmpDir: string, overrides?: Partial<Parameters<typeof init>[0]>) {
  return {
    mode: 'dev' as const,
    appDir: 'app',
    ai: true,
    projectDir: tmpDir,
    force: false,
    nonInteractive: true,
    ...overrides,
  }
}

describe('canopycms init', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-init-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates all expected files', async () => {
    await init(defaultOpts(tmpDir))

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
      const filePath = path.join(tmpDir, file)
      const stat = await fs.stat(filePath)
      expect(stat.isFile(), `Expected ${file} to exist`).toBe(true)
    }
  })

  it('generates config with correct mode for dev', async () => {
    await init(defaultOpts(tmpDir, { mode: 'dev' }))

    const config = await fs.readFile(path.join(tmpDir, 'canopycms.config.ts'), 'utf-8')
    expect(config).toContain("mode: 'dev'")
    expect(config).toContain('defineCanopyConfig')
  })

  it('generates config with correct mode for prod-sim', async () => {
    await init(defaultOpts(tmpDir, { mode: 'prod-sim' }))

    const config = await fs.readFile(path.join(tmpDir, 'canopycms.config.ts'), 'utf-8')
    expect(config).toContain("mode: 'prod-sim'")
  })

  it('generates API route with correct handler pattern', async () => {
    await init(defaultOpts(tmpDir))

    const route = await fs.readFile(
      path.join(tmpDir, 'app/api/canopycms/[...canopycms]/route.ts'),
      'utf-8',
    )
    expect(route).toContain('getHandler')
    expect(route).toContain('export const GET')
    expect(route).toContain('export const POST')
    expect(route).toContain('export const PATCH')
    expect(route).toContain('RouteContext')
  })

  it('generates edit page with auth support', async () => {
    await init(defaultOpts(tmpDir))

    const page = await fs.readFile(path.join(tmpDir, 'app/edit/page.tsx'), 'utf-8')
    expect(page).toContain("'use client'")
    expect(page).toContain('useClerkAuthConfig')
    expect(page).toContain('useDevAuthConfig')
    expect(page).toContain('NextCanopyEditorPage')
  })

  it('skips existing files in non-interactive mode', async () => {
    const configPath = path.join(tmpDir, 'canopycms.config.ts')
    await fs.writeFile(configPath, 'existing content', 'utf-8')

    await init(defaultOpts(tmpDir))

    const content = await fs.readFile(configPath, 'utf-8')
    expect(content).toBe('existing content')
  })

  it('overwrites existing files with --force', async () => {
    const configPath = path.join(tmpDir, 'canopycms.config.ts')
    await fs.writeFile(configPath, 'existing content', 'utf-8')

    await init(defaultOpts(tmpDir, { force: true }))

    const content = await fs.readFile(configPath, 'utf-8')
    expect(content).not.toBe('existing content')
    expect(content).toContain('defineCanopyConfig')
  })

  it('prompts for overwrite when interactive and file exists', async () => {
    const { confirm } = await import('@clack/prompts')
    vi.mocked(confirm).mockResolvedValueOnce(true)

    const configPath = path.join(tmpDir, 'canopycms.config.ts')
    await fs.writeFile(configPath, 'existing content', 'utf-8')

    await init(defaultOpts(tmpDir, { nonInteractive: false }))

    expect(confirm).toHaveBeenCalled()
    const content = await fs.readFile(configPath, 'utf-8')
    expect(content).toContain('defineCanopyConfig')
  })

  it('updates .gitignore if present', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf-8')

    await init(defaultOpts(tmpDir))

    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.canopy-prod-sim/')
  })

  it('creates files in custom app-dir', async () => {
    await init(defaultOpts(tmpDir, { appDir: 'src/app' }))

    const expectedFiles = [
      'canopycms.config.ts',
      'src/app/lib/canopy.ts',
      'src/app/schemas.ts',
      'src/app/api/canopycms/[...canopycms]/route.ts',
      'src/app/edit/page.tsx',
      'src/app/ai/config.ts',
      'src/app/ai/[...path]/route.ts',
    ]

    for (const file of expectedFiles) {
      const filePath = path.join(tmpDir, file)
      const stat = await fs.stat(filePath)
      expect(stat.isFile(), `Expected ${file} to exist`).toBe(true)
    }
  })

  it('adjusts import paths for custom app-dir', async () => {
    await init(defaultOpts(tmpDir, { appDir: 'src/app' }))

    const canopy = await fs.readFile(path.join(tmpDir, 'src/app/lib/canopy.ts'), 'utf-8')
    // src/app/lib/ is 3 levels deep → ../../../canopycms.config
    expect(canopy).toContain('../../../canopycms.config')

    const route = await fs.readFile(
      path.join(tmpDir, 'src/app/api/canopycms/[...canopycms]/route.ts'),
      'utf-8',
    )
    // src/app/api/canopycms/[...canopycms]/ is 6 levels deep → ../../../../../../ but we want the lib/canopy path
    expect(route).toContain('lib/canopy')

    const editPage = await fs.readFile(path.join(tmpDir, 'src/app/edit/page.tsx'), 'utf-8')
    expect(editPage).toContain('../../../canopycms.config')

    const aiRoute = await fs.readFile(path.join(tmpDir, 'src/app/ai/[...path]/route.ts'), 'utf-8')
    // src/app (depth 2) + ai/[...path] (depth 2) = 4 levels to root
    expect(aiRoute).toContain('../../../../canopycms.config')
    expect(aiRoute).toContain("from '../../schemas'")
    expect(aiRoute).toContain("from '../config'")
  })

  it('generates AI route with correct content', async () => {
    await init(defaultOpts(tmpDir))

    const aiConfigFile = await fs.readFile(path.join(tmpDir, 'app/ai/config.ts'), 'utf-8')
    expect(aiConfigFile).toContain('defineAIContentConfig')

    const aiRoute = await fs.readFile(path.join(tmpDir, 'app/ai/[...path]/route.ts'), 'utf-8')
    expect(aiRoute).toContain('createAIContentHandler')
    expect(aiRoute).toContain("from '../../schemas'")
    expect(aiRoute).toContain("from '../config'")
    // app (depth 1) + ai/[...path] (depth 2) = 3 levels to root
    expect(aiRoute).toContain("from '../../../canopycms.config'")
  })

  it('skips AI files when ai option is false', async () => {
    await init(defaultOpts(tmpDir, { ai: false }))

    await expect(fs.stat(path.join(tmpDir, 'app/ai/config.ts'))).rejects.toThrow()
    await expect(fs.stat(path.join(tmpDir, 'app/ai/[...path]/route.ts'))).rejects.toThrow()

    // Other files should still exist
    const stat = await fs.stat(path.join(tmpDir, 'app/edit/page.tsx'))
    expect(stat.isFile()).toBe(true)
  })
})

describe('canopycms init-deploy aws', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-deploy-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates Dockerfile.cms', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    expect(dockerfile).toContain('lambda-adapter')
    expect(dockerfile).toContain('CANOPY_BUILD=cms')
    expect(dockerfile).toContain('apt-get install -y git')
  })

  it('creates GitHub Actions workflow', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const workflow = await fs.readFile(
      path.join(tmpDir, '.github/workflows/deploy-cms.yml'),
      'utf-8',
    )
    expect(workflow).toContain('Deploy CMS')
    expect(workflow).toContain('docker build')
  })

  it('skips existing files in non-interactive mode', async () => {
    const dockerfilePath = path.join(tmpDir, 'Dockerfile.cms')
    await fs.writeFile(dockerfilePath, 'existing', 'utf-8')

    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const content = await fs.readFile(dockerfilePath, 'utf-8')
    expect(content).toBe('existing')
  })

  it('overwrites existing files with --force', async () => {
    const dockerfilePath = path.join(tmpDir, 'Dockerfile.cms')
    await fs.writeFile(dockerfilePath, 'existing', 'utf-8')

    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: true, nonInteractive: false })

    const content = await fs.readFile(dockerfilePath, 'utf-8')
    expect(content).not.toBe('existing')
    expect(content).toContain('lambda-adapter')
  })
})
