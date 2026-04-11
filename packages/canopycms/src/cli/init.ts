import fs from 'node:fs/promises'
import path from 'node:path'
import * as p from '@clack/prompts'
import { createJiti } from 'jiti'
import { operatingStrategy } from '../operating-mode'
import type { AuthPlugin } from '../auth/plugin'
import { filePathExists } from '../utils/fs'
import { getErrorMessage, isNotFoundError } from '../utils/error'

export type AuthProvider = 'clerk' | 'dev'

export interface InitOptions {
  mode: 'dev'
  appDir: string
  projectDir: string
  force: boolean
  nonInteractive: boolean
  ai: boolean
  /** Pre-set auth provider (skips prompt). */
  authProvider?: AuthProvider
  /** Pre-set static build choice (skips prompt). */
  staticBuild?: boolean
}

interface InitDeployOptions {
  cloud: 'aws'
  projectDir: string
  force: boolean
  nonInteractive: boolean
}

/**
 * Write a file, prompting for overwrite confirmation if it already exists.
 * Returns true if the file was written, false if skipped.
 */
async function writeFile(
  filePath: string,
  content: string,
  options: { force: boolean; nonInteractive: boolean },
): Promise<boolean> {
  const relativePath = path.relative(process.cwd(), filePath)

  if (await filePathExists(filePath)) {
    if (options.force) {
      // --force: overwrite without asking
    } else if (options.nonInteractive) {
      p.log.warn(`skip: ${relativePath} (already exists)`)
      return false
    } else {
      const overwrite = await p.confirm({
        message: `${relativePath} already exists. Overwrite?`,
        initialValue: false,
      })
      if (p.isCancel(overwrite) || !overwrite) {
        p.log.warn(`skip: ${relativePath}`)
        return false
      }
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  p.log.success(`created: ${relativePath}`)
  return true
}

/**
 * Compute the relative path from a file inside appDir to the project root.
 * e.g. appDir="app" depth=1 → "../", appDir="src/app" depth=2 → "../../"
 */
function configImportPath(appDir: string, subdirs: number): string {
  const appDepth = appDir.split('/').filter(Boolean).length
  const totalDepth = appDepth + subdirs
  return '../'.repeat(totalDepth) + 'canopycms.config'
}

/**
 * Framework integration: generates the files needed to add CanopyCMS
 * editing to a Next.js app. Cloud-agnostic.
 */
export async function init(options: InitOptions): Promise<void> {
  const { projectDir, mode, appDir, ai, force, nonInteractive } = options
  const writeOpts = { force, nonInteractive }
  const {
    canopyCmsConfig,
    canopyContext,
    schemasTemplate,
    apiRoute,
    editPage,
    aiConfig,
    aiRoute,
    nextConfig,
    middleware,
  } = await import('./templates')

  p.intro('CanopyCMS init')

  // Prompt for auth provider
  let authProvider: AuthProvider
  if (options.authProvider) {
    authProvider = options.authProvider
  } else if (nonInteractive) {
    authProvider = 'dev'
  } else {
    const choice = await p.select({
      message: 'Which auth provider will you use in production?',
      options: [
        { value: 'clerk', label: 'Clerk (+ dev auth for local development)' },
        { value: 'dev', label: 'Dev auth only' },
      ],
      initialValue: 'dev' as AuthProvider,
    })
    if (p.isCancel(choice)) {
      p.cancel('Init cancelled')
      return
    }
    authProvider = choice
  }

  // Prompt for static build
  let staticBuild: boolean
  if (options.staticBuild !== undefined) {
    staticBuild = options.staticBuild
  } else if (nonInteractive) {
    staticBuild = false
  } else {
    const choice = await p.confirm({
      message: 'Will you use dual-build (static public site + server CMS build)?',
      initialValue: false,
    })
    if (p.isCancel(choice)) {
      p.cancel('Init cancelled')
      return
    }
    staticBuild = choice
  }

  // CMS-only files use .server.tsx/.server.ts when static build is enabled
  const serverPageExt = staticBuild ? 'page.server.tsx' : 'page.tsx'
  const serverRouteExt = staticBuild ? 'route.server.ts' : 'route.ts'

  // Generate files
  await writeFile(
    path.join(projectDir, 'canopycms.config.ts'),
    await canopyCmsConfig({ mode }),
    writeOpts,
  )
  await writeFile(
    path.join(projectDir, appDir, 'lib/canopy.ts'),
    await canopyContext({ configImport: configImportPath(appDir, 1), authProvider }),
    writeOpts,
  )
  await writeFile(path.join(projectDir, appDir, 'schemas.ts'), await schemasTemplate(), writeOpts)
  await writeFile(
    path.join(projectDir, appDir, `api/canopycms/[...canopycms]/${serverRouteExt}`),
    await apiRoute({
      canopyImport: '../'.repeat(3) + 'lib/canopy',
    }),
    writeOpts,
  )
  await writeFile(
    path.join(projectDir, appDir, `edit/${serverPageExt}`),
    await editPage({ configImport: configImportPath(appDir, 1), authProvider }),
    writeOpts,
  )
  if (ai) {
    await writeFile(path.join(projectDir, appDir, 'ai/config.ts'), await aiConfig(), writeOpts)
    await writeFile(
      path.join(projectDir, appDir, 'ai/[...path]/route.ts'),
      await aiRoute({ configImport: configImportPath(appDir, 2) }),
      writeOpts,
    )
  }
  await writeFile(
    path.join(projectDir, 'next.config.ts'),
    await nextConfig({ staticBuild }),
    writeOpts,
  )
  await writeFile(
    path.join(projectDir, 'middleware.ts'),
    await middleware({ authProvider }),
    writeOpts,
  )

  // Update .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore')
  if (await filePathExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (!content.includes('.canopy-dev')) {
      await fs.appendFile(gitignorePath, '\n# CanopyCMS\n.canopy-dev/\n')
      p.log.success('updated: .gitignore')
    }
  }

  const packages =
    authProvider === 'clerk'
      ? 'canopycms canopycms-next canopycms-auth-clerk canopycms-auth-dev'
      : 'canopycms canopycms-next canopycms-auth-dev'

  p.note(
    [
      '1. Install dependencies:',
      `   npm install ${packages}`,
      '',
      '2. Customize ' + appDir + '/schemas.ts with your content schema',
      '',
      '3. Run: npm run dev',
      '4. Visit: http://localhost:3000/edit',
    ].join('\n'),
    'Next steps',
  )

  p.outro('Done!')
}

/**
 * Cloud deployment artifacts: generates AWS-specific files
 * (Dockerfile, CI workflow).
 */
export async function initDeployAws(options: InitDeployOptions): Promise<void> {
  const { projectDir, force, nonInteractive } = options
  const writeOpts = { force, nonInteractive }
  const { dockerfileCms, githubWorkflowCms } = await import('./templates')

  p.intro('CanopyCMS init-deploy aws')

  await writeFile(path.join(projectDir, 'Dockerfile.cms'), await dockerfileCms(), writeOpts)
  await writeFile(
    path.join(projectDir, '.github/workflows/deploy-cms.yml'),
    await githubWorkflowCms(),
    writeOpts,
  )

  // Check if next.config already has CANOPY_BUILD support
  const nextConfigPath = path.join(projectDir, 'next.config.ts')
  const nextConfigMjsPath = path.join(projectDir, 'next.config.mjs')
  const configPath = (await filePathExists(nextConfigPath))
    ? nextConfigPath
    : (await filePathExists(nextConfigMjsPath))
      ? nextConfigMjsPath
      : null

  if (configPath) {
    const content = await fs.readFile(configPath, 'utf-8')
    if (!content.includes('CANOPY_BUILD')) {
      p.note(
        [
          `Add dual build support to ${path.basename(configPath)}:`,
          '',
          "  output: process.env.CANOPY_BUILD === 'cms' ? 'standalone' : 'export',",
        ].join('\n'),
        'Manual step',
      )
    }
  }

  p.note(
    'CDK constructs are available via the canopycms-cdk package.\nSee the deployment plan for CDK stack setup.',
    'AWS deployment',
  )

  p.outro('Done!')
}

/**
 * Detect the CanopyCMS operating mode by importing the adopter's canopycms.config.ts.
 *
 * Returns 'dev' when the config file is absent (unconfigured project).
 * Throws when the config file is present but cannot be loaded or has an unexpected
 * shape — we refuse to silently default to 'dev' in that case because doing so in
 * a real prod deployment would mask a broken config and cause the worker-run-once
 * prod-safety guard to fall through to the dev-only task-skip path.
 *
 * Accepts the same shapes as `cli/generate-ai-content.ts`:
 * `export default defineCanopyConfig({...})` → reads `.default.server.mode`
 * `export const config = defineCanopyConfig({...})` → reads `.config.server.mode`
 * Plain object exports (used in tests) are also accepted.
 */
async function detectMode(projectDir: string): Promise<'prod' | 'dev'> {
  const cfgPath = path.join(projectDir, 'canopycms.config.ts')

  // File-absent → unconfigured project; default to dev.
  try {
    await fs.stat(cfgPath)
  } catch (err) {
    if (isNotFoundError(err)) return 'dev'
    throw err
  }

  const jiti = createJiti(import.meta.url)
  let configModule: Record<string, unknown>
  try {
    configModule = (await jiti.import(cfgPath)) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `Failed to load CanopyCMS config at ${cfgPath}: ${getErrorMessage(err)}. ` +
        `Refusing to default to dev mode — a broken config in a prod deployment ` +
        `would cause the worker-run-once prod-safety guard to silently skip prod tasks.`,
    )
  }

  // defineCanopyConfig() returns { server, client }; try default and named `config` exports.
  const configExport = configModule.default ?? configModule.config ?? configModule
  const serverConfig =
    typeof configExport === 'object' && configExport !== null && 'server' in configExport
      ? (configExport as { server: unknown }).server
      : configExport

  if (
    !serverConfig ||
    typeof serverConfig !== 'object' ||
    !('mode' in serverConfig) ||
    typeof (serverConfig as { mode: unknown }).mode !== 'string'
  ) {
    throw new Error(
      `Invalid CanopyCMS config at ${cfgPath}: expected server.mode to be a string. ` +
        `Make sure the config uses defineCanopyConfig() with a valid mode.`,
    )
  }

  const mode = (serverConfig as { mode: string }).mode
  if (mode !== 'prod' && mode !== 'dev') {
    throw new Error(
      `Invalid CanopyCMS config at ${cfgPath}: mode must be 'prod' or 'dev', got '${mode}'.`,
    )
  }
  return mode
}

/**
 * Worker run-once: process pending tasks, sync git, refresh auth cache, then exit.
 * Used in dev mode to trigger worker operations without a persistent daemon.
 */
export async function workerRunOnce(options: {
  projectDir: string
  authPlugin?: AuthPlugin
}): Promise<void> {
  // Dynamic import to avoid loading worker deps when not needed
  const { getTaskQueueDir } = await import('../worker/task-queue-config')

  // Determine workspace and mode from config by actually importing the config file.
  // A regex-based detector here is unreliable: it cannot see through spread operators,
  // helper functions, or dynamic expressions, and can silently fall through to 'dev'
  // on a real prod config — turning a prod-safety guard into a silent task-loss bug.
  const mode = await detectMode(options.projectDir)

  const taskDir = getTaskQueueDir({ mode })

  // For dev mode without GitHub, just refresh auth cache
  const cachePath =
    process.env.CANOPY_AUTH_CACHE_PATH ??
    path.join(operatingStrategy(mode).getWorkspaceRoot(options.projectDir), '.cache')

  let refreshAuthCache: (() => Promise<void>) | undefined
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

  if (options.authPlugin?.createCacheRefresher) {
    const refresher = options.authPlugin.createCacheRefresher(cachePath)
    if (refresher) {
      refreshAuthCache = async () => {
        const result = await refresher()
        console.log(`  ${result.userCount} users, ${result.groupCount} groups`)
      }
    }
  }
  console.log(`\nCanopyCMS worker run-once (mode: ${mode}, auth: ${authMode})\n`)

  // Refresh auth cache
  if (refreshAuthCache) {
    console.log('Refreshing auth cache...')
    await refreshAuthCache()
    console.log('Auth cache refreshed')
  }

  // Process task queue (if any pending tasks)
  const { dequeueTask, completeTask, listTasks } = await import('../worker/task-queue')

  if (mode === 'prod') {
    // In prod mode, tasks are real GitHub operations (push-branch, create-PR, etc.).
    // Silently skipping them with {skipped:true} permanently loses that work.
    // Check for pending tasks WITHOUT dequeuing — dequeue moves tasks to processing/
    // and an abandoned processing/ file is harder to recover than a pending/ file.
    const pending = await listTasks(taskDir, 'pending')
    if (pending.length > 0) {
      throw new Error(
        `workerRunOnce found ${pending.length} pending task(s) in prod mode but cannot execute them. ` +
          `Use the full worker daemon to process prod task queues.`,
      )
    }
    console.log('No pending tasks')
  } else {
    // Dev mode: skip tasks with a warning (no GitHub credentials available)
    let taskCount = 0
    let task = await dequeueTask(taskDir)
    while (task !== null) {
      console.log(`Processing task: ${task.action} (${task.id})`)
      console.warn(`  WARNING: Task skipped — GitHub operations require the full worker daemon`)
      await completeTask(taskDir, task.id, { skipped: true })
      taskCount++
      task = await dequeueTask(taskDir)
    }
    if (taskCount > 0) {
      console.log(`Processed ${taskCount} task(s)`)
    } else {
      console.log('No pending tasks')
    }
  }

  console.log('\nDone')
}
