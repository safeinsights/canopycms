import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { init, initDeployAws, workerRunOnce } from './init'
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
  select: vi.fn().mockResolvedValue('dev'),
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
      'next.config.ts',
      'middleware.ts',
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

  it('generates next.config.ts with withCanopy wrapper', async () => {
    await init(defaultOpts(tmpDir))

    const config = await fs.readFile(path.join(tmpDir, 'next.config.ts'), 'utf-8')
    expect(config).toContain('withCanopy')
    expect(config).toContain("from 'canopycms-next/config'")
  })

  it('generates config with correct mode for dev', async () => {
    await init(defaultOpts(tmpDir, { mode: 'dev' }))

    const config = await fs.readFile(path.join(tmpDir, 'canopycms.config.ts'), 'utf-8')
    expect(config).toContain("mode: 'dev'")
    expect(config).toContain('defineCanopyConfig')
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

  it('generates dev-only edit page by default (non-interactive)', async () => {
    await init(defaultOpts(tmpDir))

    const page = await fs.readFile(path.join(tmpDir, 'app/edit/page.tsx'), 'utf-8')
    expect(page).toContain("'use client'")
    expect(page).toContain('useDevAuthConfig')
    expect(page).toContain('NextCanopyEditorPage')
    expect(page).not.toContain('useClerkAuthConfig')
  })

  it('generates clerk+dev edit page when authProvider is clerk', async () => {
    await init(defaultOpts(tmpDir, { authProvider: 'clerk' }))

    const page = await fs.readFile(path.join(tmpDir, 'app/edit/page.tsx'), 'utf-8')
    expect(page).toContain('useClerkAuthConfig')
    expect(page).toContain('useDevAuthConfig')
    expect(page).toContain('NextCanopyEditorPage')
  })

  it('generates dev-only canopy.ts by default (non-interactive)', async () => {
    await init(defaultOpts(tmpDir))

    const canopy = await fs.readFile(path.join(tmpDir, 'app/lib/canopy.ts'), 'utf-8')
    expect(canopy).toContain('createDevAuthPlugin')
    expect(canopy).not.toContain('createClerkAuthPlugin')
  })

  it('generates clerk+dev canopy.ts when authProvider is clerk', async () => {
    await init(defaultOpts(tmpDir, { authProvider: 'clerk' }))

    const canopy = await fs.readFile(path.join(tmpDir, 'app/lib/canopy.ts'), 'utf-8')
    expect(canopy).toContain('createClerkAuthPlugin')
    expect(canopy).toContain('createDevAuthPlugin')
  })

  it('generates passthrough middleware by default', async () => {
    await init(defaultOpts(tmpDir))

    const mw = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
    expect(mw).toContain('NextResponse.next()')
    // Clerk middleware appears in comments as a guide, but not as active code
    expect(mw).toContain('export default function middleware()')
  })

  it('generates clerk middleware when authProvider is clerk', async () => {
    await init(defaultOpts(tmpDir, { authProvider: 'clerk' }))

    const mw = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
    expect(mw).toContain('clerkMiddleware')
    expect(mw).toContain('isProtectedRoute')
  })

  it('generates dual-build next.config when staticBuild is true', async () => {
    await init(defaultOpts(tmpDir, { staticBuild: true }))

    const config = await fs.readFile(path.join(tmpDir, 'next.config.ts'), 'utf-8')
    expect(config).toContain('CANOPY_BUILD')
    expect(config).toContain('staticBuild')
  })

  it('uses .server extensions for CMS-only files when staticBuild is true', async () => {
    await init(defaultOpts(tmpDir, { staticBuild: true }))

    const editPage = path.join(tmpDir, 'app/edit/page.server.tsx')
    const stat = await fs.stat(editPage)
    expect(stat.isFile()).toBe(true)

    const apiRoute = path.join(tmpDir, 'app/api/canopycms/[...canopycms]/route.server.ts')
    const routeStat = await fs.stat(apiRoute)
    expect(routeStat.isFile()).toBe(true)

    // Regular extensions should NOT exist
    await expect(fs.stat(path.join(tmpDir, 'app/edit/page.tsx'))).rejects.toThrow()
    await expect(
      fs.stat(path.join(tmpDir, 'app/api/canopycms/[...canopycms]/route.ts')),
    ).rejects.toThrow()
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
    // First confirm call = static build prompt (false), second = overwrite prompt (true)
    vi.mocked(confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

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
    expect(gitignore).toContain('.canopy-dev/')
  })

  it('creates files in custom app-dir', async () => {
    await init(defaultOpts(tmpDir, { appDir: 'src/app' }))

    const expectedFiles = [
      'canopycms.config.ts',
      'next.config.ts',
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

describe('workerRunOnce', () => {
  let tmpDir: string
  const originalWorkspaceRoot = process.env.CANOPYCMS_WORKSPACE_ROOT

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-test-'))
    // Redirect the prod workspace to tmpDir so getTaskQueueDir doesn't point to /mnt/efs
    process.env.CANOPYCMS_WORKSPACE_ROOT = tmpDir
  })

  afterEach(async () => {
    process.env.CANOPYCMS_WORKSPACE_ROOT = originalWorkspaceRoot
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('throws when prod mode has pending tasks (prevents silent task loss)', async () => {
    // Write a canopycms.config.ts that declares mode: 'prod'
    // Note: the mode regex requires `mode:` at or near the start of a line
    await fs.writeFile(
      path.join(tmpDir, 'canopycms.config.ts'),
      `export default defineCanopyConfig({\n  mode: 'prod',\n})`,
      'utf-8',
    )

    // Enqueue a task in the prod task directory (redirected to tmpDir via env var)
    const { getTaskQueueDir } = await import('../worker/task-queue-config')
    const { enqueueTask } = await import('../worker/task-queue')
    const taskDir = getTaskQueueDir({ mode: 'prod' })
    await enqueueTask(taskDir, { action: 'push-branch', payload: { branch: 'feature-x' } })

    await expect(workerRunOnce({ projectDir: tmpDir })).rejects.toThrow(
      /prod.*full worker daemon|full worker daemon.*prod/i,
    )

    // Critical: tasks must remain in pending/ — NOT moved to processing/.
    // The original fix called dequeueTask() before throwing, which stranded
    // tasks in processing/ and made them harder to recover than leaving them pending.
    const pendingFiles = await fs.readdir(path.join(taskDir, 'pending'))
    expect(pendingFiles).toHaveLength(1)
    const processingDir = path.join(taskDir, 'processing')
    const processingFiles = await fs.readdir(processingDir).catch(() => [])
    expect(processingFiles).toHaveLength(0)
  })

  it('warns and skips tasks in dev mode (expected behavior for dev-only workflow)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'canopycms.config.ts'),
      `export default defineCanopyConfig({ mode: 'dev' })`,
      'utf-8',
    )
    // No tasks enqueued — should complete without error
    await expect(workerRunOnce({ projectDir: tmpDir })).resolves.toBeUndefined()
  })
})
