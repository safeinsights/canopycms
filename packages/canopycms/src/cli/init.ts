import fs from 'node:fs/promises'
import path from 'node:path'
import * as p from '@clack/prompts'
import { operatingStrategy } from '../operating-mode'
import type { AuthPlugin } from '../auth/plugin'
import { filePathExists } from '../utils/fs'

export interface InitOptions {
  mode: 'dev'
  appDir: string
  projectDir: string
  force: boolean
  nonInteractive: boolean
  ai: boolean
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
  const { canopyCmsConfig, canopyContext, schemasTemplate, apiRoute, editPage, aiConfig, aiRoute } =
    await import('./templates')

  p.intro('CanopyCMS init')

  // Generate files
  await writeFile(
    path.join(projectDir, 'canopycms.config.ts'),
    await canopyCmsConfig({ mode }),
    writeOpts,
  )
  await writeFile(
    path.join(projectDir, appDir, 'lib/canopy.ts'),
    await canopyContext({ configImport: configImportPath(appDir, 1) }),
    writeOpts,
  )
  await writeFile(path.join(projectDir, appDir, 'schemas.ts'), await schemasTemplate(), writeOpts)
  await writeFile(
    path.join(projectDir, appDir, 'api/canopycms/[...canopycms]/route.ts'),
    await apiRoute({
      canopyImport: '../'.repeat(3) + 'lib/canopy',
    }),
    writeOpts,
  )
  await writeFile(
    path.join(projectDir, appDir, 'edit/page.tsx'),
    await editPage({ configImport: configImportPath(appDir, 1) }),
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

  // Update .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore')
  if (await filePathExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (!content.includes('.canopy-dev')) {
      await fs.appendFile(gitignorePath, '\n# CanopyCMS\n.canopy-dev/\n')
      p.log.success('updated: .gitignore')
    }
  }

  p.note(
    [
      '1. Install dependencies:',
      `   npm install canopycms canopycms-next canopycms-auth-clerk canopycms-auth-dev`,
      '',
      '2. Wrap your Next.js config:',
      "   import { withCanopy } from 'canopycms-next'",
      '   export default withCanopy({ /* your config */ })',
      '',
      '3. Customize ' + appDir + '/schemas.ts with your content schema',
      '',
      '4. Run: npm run dev',
      '5. Visit: http://localhost:3000/edit',
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
 * Worker run-once: process pending tasks, sync git, refresh auth cache, then exit.
 * Used in dev mode to trigger worker operations without a persistent daemon.
 */
export async function workerRunOnce(options: {
  projectDir: string
  authPlugin?: AuthPlugin
}): Promise<void> {
  // Dynamic import to avoid loading worker deps when not needed
  const { getTaskQueueDir } = await import('../worker/task-queue-config')

  // Determine workspace and mode from config
  const cfgPath = path.join(options.projectDir, 'canopycms.config.ts')
  let mode: 'prod' | 'dev' = 'dev'
  try {
    const configContent = await fs.readFile(cfgPath, 'utf-8')
    // Match the mode property in the config object, not in comments or strings
    if (/^\s*mode:\s*['"]prod['"]\s*[,}]/m.test(configContent)) {
      mode = 'prod'
    }
  } catch {
    // Default to dev
  }

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
  const { dequeueTask, completeTask } = await import('../worker/task-queue')
  let taskCount = 0
  let task
  while ((task = await dequeueTask(taskDir)) !== null) {
    console.log(`Processing task: ${task.action} (${task.id})`)
    // In dev mode without GitHub, just mark tasks as completed
    // A real worker would execute the GitHub operations
    console.warn(`  WARNING: Task skipped — GitHub operations require the full worker daemon`)
    await completeTask(taskDir, task.id, { skipped: true })
    taskCount++
  }

  if (taskCount > 0) {
    console.log(`Processed ${taskCount} task(s)`)
  } else {
    console.log('No pending tasks')
  }

  console.log('\nDone')
}
