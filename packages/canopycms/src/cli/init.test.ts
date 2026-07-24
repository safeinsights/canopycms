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

  it('clerk canopy.ts fails closed: prod always uses Clerk, never dev auth (SEC-C1)', async () => {
    await init(defaultOpts(tmpDir, { authProvider: 'clerk' }))

    const canopy = await fs.readFile(path.join(tmpDir, 'app/lib/canopy.ts'), 'utf-8')
    // Plugin selection must consider the operating mode, not just an env var:
    // prod picks Clerk even when CANOPY_AUTH_MODE is unset/misspelled/dropped.
    expect(canopy).toContain("config.server.mode === 'prod' ||")
    // The old footgun keyed selection on the env var ALONE (dev fallback in prod).
    expect(canopy).not.toMatch(/authPlugin[:=]\s*\n?\s*process\.env\.CANOPY_AUTH_MODE/)
  })

  it('generates passthrough middleware by default', async () => {
    await init(defaultOpts(tmpDir))

    const mw = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
    expect(mw).toContain('NextResponse.next()')
    // Clerk middleware appears in comments as a guide, but not as active code
    expect(mw).toContain('export default function middleware()')
  })

  it('passthrough middleware warns when CANOPY_AUTH_MODE=clerk but middleware was not regenerated', async () => {
    await init(defaultOpts(tmpDir))

    // ADO-M1: middleware.ts is frozen at init time and does not read CANOPY_AUTH_MODE
    // at runtime like canopy.ts/edit page do. It should at least warn about the
    // mismatch so an adopter who flips the env var without swapping this file notices.
    const mw = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
    expect(mw).toContain("process.env.CANOPY_AUTH_MODE === 'clerk'")
    expect(mw).toContain('console.warn')
  })

  it('generates clerk middleware when authProvider is clerk', async () => {
    await init(defaultOpts(tmpDir, { authProvider: 'clerk' }))

    const mw = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
    expect(mw).toContain('clerkMiddleware')
    expect(mw).toContain('isProtectedRoute')
  })

  it('clerk middleware passes an explicit jwtKey so cold verification never hits the network (B2)', async () => {
    await init(defaultOpts(tmpDir, { authProvider: 'clerk' }))

    // Without an explicit jwtKey, @clerk/nextjs fetches JWKS from api.clerk.com
    // on cold verification; the prod CMS Lambda has no internet and hangs.
    const mw = await fs.readFile(path.join(tmpDir, 'middleware.ts'), 'utf-8')
    expect(mw).toContain('jwtKey: process.env.CLERK_JWT_KEY')
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

  it('uses .server extension for the AI route when staticBuild is true', async () => {
    await init(defaultOpts(tmpDir, { staticBuild: true }))

    const aiRoute = path.join(tmpDir, 'app/ai/[...path]/route.server.ts')
    const stat = await fs.stat(aiRoute)
    expect(stat.isFile()).toBe(true)

    // A plain route.ts here would land in the static export build and break output:'export'
    await expect(fs.stat(path.join(tmpDir, 'app/ai/[...path]/route.ts'))).rejects.toThrow()
  })

  it('adds a CANOPY_BUILD-driven deployedAs to the config when staticBuild is true', async () => {
    await init(defaultOpts(tmpDir, { staticBuild: true }))

    const config = await fs.readFile(path.join(tmpDir, 'canopycms.config.ts'), 'utf-8')
    expect(config).toContain(
      "deployedAs: process.env.CANOPY_BUILD === 'static' ? 'static' : 'server',",
    )
  })

  it('omits deployedAs from the config by default', async () => {
    await init(defaultOpts(tmpDir))

    const config = await fs.readFile(path.join(tmpDir, 'canopycms.config.ts'), 'utf-8')
    expect(config).not.toContain('deployedAs')
    expect(config).not.toContain('{{DEPLOYED_AS}}')
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

  it('Dockerfile.cms references the real aws-lambda-adapter image repo (B3)', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    // public.ecr.aws/awsguru/aws-lambda-web-adapter does not exist -- the real
    // repo is aws-lambda-adapter (no "web-"). Referencing the wrong one fails
    // the COPY --from= at build time.
    expect(dockerfile).toContain('aws-lambda-adapter:1.0.1')
    expect(dockerfile).not.toContain('aws-lambda-web-adapter')
  })

  it('Dockerfile.cms passes NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY into the build stage', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    // Next.js inlines NEXT_PUBLIC_* values into the client bundle at build time,
    // so the Clerk publishable key must be threaded through as a build ARG.
    expect(dockerfile).toContain('ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
    expect(dockerfile).toContain(
      'ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    )
  })

  it('Dockerfile.cms symlinks .next/cache to /tmp for the read-only Lambda filesystem', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    expect(dockerfile).toContain('rm -rf .next/cache && ln -s /tmp .next/cache')
  })

  it('Dockerfile.cms sets safe.directory in SYSTEM gitconfig (env-based GIT_CONFIG_* is blocked by simple-git)', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    expect(dockerfile).toContain("git config --system safe.directory '*'")
  })

  it('Dockerfile.cms guards against adopter apps with no public/ dir', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    expect(dockerfile).toContain('mkdir -p public')
  })

  it('Dockerfile.cms synthesizes a git repo for dev-mode build reads and never bakes prod mode into the build', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    // Dev-mode build-time content reads require a git repo; .dockerignore
    // excludes .git, so the builder must create one from the copied files.
    expect(dockerfile).toContain('git init -q -b main')
    expect(dockerfile).toContain('image build snapshot')
    // Prod-mode build reads would need an EFS remote.git inside the builder;
    // validated to fail in the deploy-test harness. Prod is runtime-only.
    expect(dockerfile).not.toContain('ENV CANOPY_MODE=prod')
  })

  it('Dockerfile.cms keeps node_modules out of the synthesized snapshot repo without touching adopter files', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    // npm ci runs before git init, so node_modules exists at `git add -A` time;
    // .git/info/exclude keeps it out even when the adopter repo has no .gitignore.
    expect(dockerfile).toContain('.git/info/exclude')
    expect(dockerfile).toContain('node_modules\\n.next\\n')
  })

  it('creates .dockerignore that excludes host node_modules but keeps vendor/', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const dockerignore = await fs.readFile(path.join(tmpDir, '.dockerignore'), 'utf-8')
    expect(dockerignore).toContain('node_modules')
    expect(dockerignore).toContain('.env*')
    expect(dockerignore).toContain('cdk.out')
    // vendor/ must reach the build context -- file: deps resolve from it. No
    // active ignore pattern should exclude it (a comment explaining why is fine).
    const ignoreLines = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    expect(ignoreLines).not.toContain('vendor')
    expect(ignoreLines).not.toContain('vendor/')
  })

  it('skips existing .dockerignore in non-interactive mode', async () => {
    const dockerignorePath = path.join(tmpDir, '.dockerignore')
    await fs.writeFile(dockerignorePath, 'existing', 'utf-8')

    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: false, nonInteractive: true })

    const content = await fs.readFile(dockerignorePath, 'utf-8')
    expect(content).toBe('existing')
  })

  it('overwrites existing .dockerignore with --force', async () => {
    const dockerignorePath = path.join(tmpDir, '.dockerignore')
    await fs.writeFile(dockerignorePath, 'existing', 'utf-8')

    await initDeployAws({ cloud: 'aws', projectDir: tmpDir, force: true, nonInteractive: false })

    const content = await fs.readFile(dockerignorePath, 'utf-8')
    expect(content).not.toBe('existing')
    expect(content).toContain('node_modules')
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

  // Helper: write a config fixture that jiti can actually import.
  // We use a plain-object default export matching the shape `defineCanopyConfig()` produces
  // (`{ server: {...} }`) so tests don't need to resolve the real canopycms package import.
  async function writeConfig(mode: string | null): Promise<void> {
    const modeField = mode === null ? '' : `mode: '${mode}',`
    await fs.writeFile(
      path.join(tmpDir, 'canopycms.config.ts'),
      `export default { server: { ${modeField} } }`,
      'utf-8',
    )
  }

  it('throws when prod mode has pending tasks (prevents silent task loss)', async () => {
    await writeConfig('prod')

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
    await writeConfig('dev')
    // No tasks enqueued — should complete without error
    await expect(workerRunOnce({ projectDir: tmpDir })).resolves.toBeUndefined()
  })

  it('defaults to dev when canopycms.config.ts is missing', async () => {
    // No config file — unconfigured project should default to dev, not error.
    await expect(workerRunOnce({ projectDir: tmpDir })).resolves.toBeUndefined()
  })

  it('throws when the config file is present but fails to import', async () => {
    // A syntactically broken config must NOT silently default to dev — in a real
    // prod deployment that would cause workerRunOnce to fall through to the dev
    // task-skip path and silently discard pending prod tasks.
    await fs.writeFile(
      path.join(tmpDir, 'canopycms.config.ts'),
      `this is not valid typescript {{{ <- syntax error`,
      'utf-8',
    )
    await expect(workerRunOnce({ projectDir: tmpDir })).rejects.toThrow(
      /Failed to load CanopyCMS config/,
    )
  })

  it('throws when the config has no mode field', async () => {
    // Invalid shape — the detector should not guess.
    await writeConfig(null)
    await expect(workerRunOnce({ projectDir: tmpDir })).rejects.toThrow(
      /expected server\.mode to be a string/,
    )
  })

  it('throws when the config has an unexpected mode value', async () => {
    await writeConfig('staging')
    await expect(workerRunOnce({ projectDir: tmpDir })).rejects.toThrow(
      /mode must be 'prod' or 'dev'/,
    )
  })

  it('reads mode from a dynamically-computed expression (regex-detector would miss this)', async () => {
    // The previous regex-based detector could not see through function calls or
    // conditional expressions. With jiti we actually evaluate the module, so
    // `mode` resolves to its real runtime value regardless of how it was written.
    await fs.writeFile(
      path.join(tmpDir, 'canopycms.config.ts'),
      [
        `const computeMode = () => 'prod' as const`,
        `export default { server: { mode: computeMode() } }`,
      ].join('\n'),
      'utf-8',
    )

    // Enqueue a task so we can observe the prod-mode guard firing.
    const { getTaskQueueDir } = await import('../worker/task-queue-config')
    const { enqueueTask } = await import('../worker/task-queue')
    const taskDir = getTaskQueueDir({ mode: 'prod' })
    await enqueueTask(taskDir, { action: 'push-branch', payload: { branch: 'feature-x' } })

    // If the detector still used regex, it would match neither `mode: computeMode()`
    // nor any literal 'prod', fall through to dev, and dequeueTask would silently
    // skip the task. The jiti-based detector should resolve the real value and throw.
    await expect(workerRunOnce({ projectDir: tmpDir })).rejects.toThrow(
      /prod.*full worker daemon|full worker daemon.*prod/i,
    )

    const pendingFiles = await fs.readdir(path.join(taskDir, 'pending'))
    expect(pendingFiles).toHaveLength(1)
  })
})
