#!/usr/bin/env tsx

import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import {
  canopyCmsConfig,
  canopyContext,
  schemasTemplate,
  apiRoute,
  editPage,
  aiConfig,
  aiRoute,
  dockerfileCms,
  githubWorkflowCms,
} from './templates'
import { operatingStrategy } from '../operating-mode'

export interface InitOptions {
  mode: 'prod-sim' | 'dev'
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
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

  if (await fileExists(filePath)) {
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
  if (await fileExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (!content.includes('.canopy-prod-sim')) {
      await fs.appendFile(gitignorePath, '\n# CanopyCMS\n.canopy-prod-sim/\n.canopy-dev/\n')
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
  const configPath = (await fileExists(nextConfigPath))
    ? nextConfigPath
    : (await fileExists(nextConfigMjsPath))
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
 * Used in prod-sim to trigger worker operations without a persistent daemon.
 */
export async function workerRunOnce(options: { projectDir: string }): Promise<void> {
  // Dynamic import to avoid loading worker deps when not needed
  const { getTaskQueueDir } = await import('../worker/task-queue-config')

  // Determine workspace and mode from config
  const cfgPath = path.join(options.projectDir, 'canopycms.config.ts')
  let mode: 'prod' | 'prod-sim' = 'prod-sim'
  try {
    const configContent = await fs.readFile(cfgPath, 'utf-8')
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
    process.env.CANOPY_AUTH_CACHE_PATH ??
    path.join(operatingStrategy(mode).getWorkspaceRoot(options.projectDir), '.cache')

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

/** Parse CLI flags from argv, returning values and remaining positional args. */
function parseFlags(args: string[]): {
  flags: Record<string, string | boolean>
  positional: string[]
} {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      // Boolean flags
      if (key === 'force' || key === 'non-interactive' || key === 'no-ai') {
        flags[key] = true
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i]
      }
    } else {
      positional.push(arg)
    }
  }

  return { flags, positional }
}

// CLI entrypoint
async function main() {
  const args = process.argv.slice(2)
  const { flags, positional } = parseFlags(args)
  const command = positional[0]

  if (command === 'init') {
    const nonInteractive = flags['non-interactive'] === true
    const force = flags['force'] === true

    let mode: 'dev' | 'prod-sim'
    if (flags['mode'] === 'dev' || flags['mode'] === 'prod-sim') {
      mode = flags['mode']
    } else if (nonInteractive) {
      mode = 'dev'
    } else {
      const result = await p.select({
        message: 'Which operating mode?',
        options: [
          { value: 'dev' as const, label: 'dev', hint: 'Direct editing in current checkout' },
          {
            value: 'prod-sim' as const,
            label: 'prod-sim',
            hint: 'Simulates production with local branch clones',
          },
        ],
        initialValue: 'dev' as const,
      })
      if (p.isCancel(result)) {
        p.cancel('Init cancelled.')
        process.exit(0)
      }
      mode = result
    }

    let appDir: string
    if (typeof flags['app-dir'] === 'string') {
      appDir = flags['app-dir']
    } else if (nonInteractive) {
      appDir = 'app'
    } else {
      const result = await p.text({
        message: 'App directory?',
        placeholder: 'app',
        defaultValue: 'app',
      })
      if (p.isCancel(result)) {
        p.cancel('Init cancelled.')
        process.exit(0)
      }
      appDir = result
    }

    let ai: boolean
    if (flags['no-ai'] === true) {
      ai = false
    } else if (nonInteractive) {
      ai = true
    } else {
      const result = await p.confirm({
        message: 'Include AI content endpoint?',
        initialValue: true,
      })
      if (p.isCancel(result)) {
        p.cancel('Init cancelled.')
        process.exit(0)
      }
      ai = result
    }

    await init({
      mode,
      appDir,
      ai,
      projectDir: process.cwd(),
      force,
      nonInteractive,
    })
  } else if (command === 'init-deploy') {
    const cloud = positional[1]
    if (cloud !== 'aws') {
      console.error('Usage: canopycms init-deploy aws')
      console.error('Only "aws" is currently supported.')
      process.exit(1)
    }
    await initDeployAws({
      cloud: 'aws',
      projectDir: process.cwd(),
      force: flags['force'] === true,
      nonInteractive: flags['non-interactive'] === true,
    })
  } else if (command === 'worker') {
    const subcommand = positional[1]
    if (subcommand !== 'run-once') {
      console.error('Usage: canopycms worker run-once')
      process.exit(1)
    }
    await workerRunOnce({ projectDir: process.cwd() })
  } else if (command === 'generate-ai-content') {
    const { generateAIContentCLI } = await import('./generate-ai-content')
    await generateAIContentCLI({
      projectDir: process.cwd(),
      outputDir: typeof flags['output'] === 'string' ? flags['output'] : undefined,
      configPath: typeof flags['config'] === 'string' ? flags['config'] : undefined,
    })
  } else {
    console.log('CanopyCMS CLI')
    console.log('')
    console.log('Commands:')
    console.log('  init                    Add CanopyCMS to a Next.js app')
    console.log('    --mode <dev|prod-sim> Operating mode (default: dev)')
    console.log('    --app-dir <path>      App directory (default: app)')
    console.log('    --no-ai               Skip AI content endpoint generation')
    console.log('    --force               Overwrite existing files without asking')
    console.log('    --non-interactive     Use defaults, no prompts')
    console.log('')
    console.log('  init-deploy aws         Generate AWS deployment artifacts')
    console.log('    --force               Overwrite existing files without asking')
    console.log('    --non-interactive     Use defaults, no prompts')
    console.log('')
    console.log('  worker run-once         Process tasks, sync git, refresh auth cache')
    console.log('  generate-ai-content     Generate static AI-ready content files')
    console.log('    --output <dir>        Output directory (default: public/ai)')
    console.log('    --config <path>       Path to AI content config file')
    process.exit(0)
  }
}

// Only run when executed directly as a CLI, not when imported in tests.
// Use realpathSync to resolve symlinks — npx creates a symlink in node_modules/.bin/
// that won't match import.meta.url's resolved real path.
const __filename = fileURLToPath(import.meta.url)
const isDirectRun = realpathSync(process.argv[1]) === realpathSync(__filename)

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
