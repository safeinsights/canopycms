#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canopyCmsConfig,
  canopyContextClerk,
  schemasTemplate,
  apiRoute,
  editPageClerk,
  dockerfileCms,
  githubWorkflowCms,
} from './templates'

interface InitOptions {
  authProvider: 'clerk'
  mode: 'prod-sim' | 'dev'
  projectDir: string
}

interface InitDeployOptions {
  cloud: 'aws'
  projectDir: string
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function writeIfNotExists(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) {
    console.log(`  skip: ${path.relative(process.cwd(), filePath)} (already exists)`)
    return false
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  console.log(`  created: ${path.relative(process.cwd(), filePath)}`)
  return true
}

/**
 * Framework integration: generates the files needed to add CanopyCMS
 * editing to a Next.js app. Cloud-agnostic.
 */
export async function init(options: InitOptions): Promise<void> {
  const { projectDir, mode } = options

  console.log('\nCanopyCMS init\n')

  // Generate files
  await writeIfNotExists(
    path.join(projectDir, 'canopycms.config.ts'),
    await canopyCmsConfig({ mode }),
  )
  await writeIfNotExists(path.join(projectDir, 'app/lib/canopy.ts'), await canopyContextClerk())
  await writeIfNotExists(path.join(projectDir, 'app/schemas.ts'), await schemasTemplate())
  await writeIfNotExists(
    path.join(projectDir, 'app/api/canopycms/[...canopycms]/route.ts'),
    await apiRoute(),
  )
  await writeIfNotExists(path.join(projectDir, 'app/edit/page.tsx'), await editPageClerk())

  // Update .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore')
  if (await fileExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (!content.includes('.canopy-prod-sim')) {
      await fs.appendFile(gitignorePath, '\n# CanopyCMS\n.canopy-prod-sim/\n.canopy-dev/\n')
      console.log('  updated: .gitignore')
    }
  }

  console.log(`
Next steps:
  1. Install dependencies:
     npm install canopycms canopycms-next canopycms-auth-clerk canopycms-auth-dev

  2. Add transpilePackages to next.config.ts:
     transpilePackages: ['canopycms']

  3. Customize app/schemas.ts with your content schema

  4. Run: npm run dev
  5. Visit: http://localhost:3000/edit
`)
}

/**
 * Cloud deployment artifacts: generates AWS-specific files
 * (Dockerfile, CI workflow).
 */
export async function initDeployAws(options: InitDeployOptions): Promise<void> {
  const { projectDir } = options

  console.log('\nCanopyCMS init-deploy aws\n')

  await writeIfNotExists(path.join(projectDir, 'Dockerfile.cms'), await dockerfileCms())
  await writeIfNotExists(
    path.join(projectDir, '.github/workflows/deploy-cms.yml'),
    await githubWorkflowCms(),
  )

  // Check if next.config already has CANOPY_BUILD support
  const nextConfigPath = path.join(projectDir, 'next.config.ts')
  const nextConfigMjsPath = path.join(projectDir, 'next.config.mjs')
  const configPath = (await fileExists(nextConfigPath))
    ? nextConfigPath
    : (await fileExists(nextConfigMjsPath))
      ? nextConfigMjsPath
      : null

  if (configPath) {
    const content = await fs.readFile(configPath, 'utf-8')
    if (!content.includes('CANOPY_BUILD')) {
      console.log(`
  NOTE: Add dual build support to ${path.basename(configPath)}:

    output: process.env.CANOPY_BUILD === 'cms' ? 'standalone' : 'export',
`)
    }
  }

  console.log(`
  CDK constructs are available via the canopycms-cdk package.
  See the deployment plan for CDK stack setup.
`)
}

/**
 * Worker run-once: process pending tasks, sync git, refresh auth cache, then exit.
 * Used in prod-sim to trigger worker operations without a persistent daemon.
 */
export async function workerRunOnce(options: { projectDir: string }): Promise<void> {
  // Dynamic import to avoid loading worker deps when not needed
  const { getTaskQueueDir } = await import('../worker/task-queue-config')

  // Determine workspace and mode from config
  const configPath = path.join(options.projectDir, 'canopycms.config.ts')
  let mode: 'prod' | 'prod-sim' = 'prod-sim'
  try {
    const configContent = await fs.readFile(configPath, 'utf-8')
    // Match the mode property in the config object, not in comments or strings
    if (/^\s*mode:\s*['"]prod['"]\s*[,}]/m.test(configContent)) {
      mode = 'prod'
    }
  } catch {
    // Default to prod-sim
  }

  const taskDir = getTaskQueueDir({ mode })
  if (!taskDir) {
    console.log('Worker not needed in dev mode')
    return
  }

  // For prod-sim without GitHub, just refresh auth cache
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'
  const cachePath =
    mode === 'prod-sim'
      ? path.join(options.projectDir, '.canopy-prod-sim', '.cache')
      : path.join(process.env.CANOPYCMS_WORKSPACE_ROOT ?? '/mnt/efs/workspace', '.cache')

  let refreshAuthCache: (() => Promise<void>) | undefined

  if (authMode === 'clerk') {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY
    if (clerkSecretKey) {
      const { refreshClerkCache } = await import('canopycms-auth-clerk/cache-writer')
      refreshAuthCache = async () => {
        const result = await refreshClerkCache({
          secretKey: clerkSecretKey,
          cachePath,
        })
        console.log(`  ${result.userCount} users, ${result.groupCount} groups`)
      }
    }
  } else if (authMode === 'dev') {
    const { refreshDevCache } = await import('canopycms-auth-dev/cache-writer')
    refreshAuthCache = async () => {
      const result = await refreshDevCache({ cachePath })
      console.log(`  ${result.userCount} users, ${result.groupCount} groups`)
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
    // In prod-sim without GitHub, just mark tasks as completed
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

// CLI entrypoint
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'init') {
    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: process.cwd(),
    })
  } else if (command === 'init-deploy') {
    const cloud = args[1]
    if (cloud !== 'aws') {
      console.error('Usage: canopycms init-deploy aws')
      console.error('Only "aws" is currently supported.')
      process.exit(1)
    }
    await initDeployAws({
      cloud: 'aws',
      projectDir: process.cwd(),
    })
  } else if (command === 'worker') {
    const subcommand = args[1]
    if (subcommand !== 'run-once') {
      console.error('Usage: canopycms worker run-once')
      process.exit(1)
    }
    await workerRunOnce({ projectDir: process.cwd() })
  } else {
    console.log('CanopyCMS CLI')
    console.log('')
    console.log('Commands:')
    console.log('  init              Add CanopyCMS to a Next.js app')
    console.log('  init-deploy aws   Generate AWS deployment artifacts')
    console.log('  worker run-once   Process tasks, sync git, refresh auth cache')
    process.exit(0)
  }
}

// Only run when executed directly as a CLI, not when imported in tests
const __filename = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] === __filename

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
