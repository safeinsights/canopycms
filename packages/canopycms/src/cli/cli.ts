#!/usr/bin/env tsx

/**
 * CanopyCMS CLI entrypoint.
 *
 * Routes commands to their implementations:
 *   init, init-deploy, worker, generate-ai-content, sync
 *
 * Command implementations live in separate files (init.ts, sync.ts, etc.)
 * and are dynamically imported to keep startup fast.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import type { AuthPlugin } from '../auth/plugin'

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
      if (
        key === 'force' ||
        key === 'non-interactive' ||
        key === 'no-ai' ||
        key === 'push' ||
        key === 'pull'
      ) {
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
    const { init } = await import('./init')
    const nonInteractive = flags['non-interactive'] === true
    const force = flags['force'] === true

    const mode = 'dev' as const

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
    const { initDeployAws } = await import('./init')
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
    const { workerRunOnce } = await import('./init')
    const subcommand = positional[1]
    if (subcommand !== 'run-once') {
      console.error('Usage: canopycms worker run-once')
      process.exit(1)
    }
    // Resolve auth plugin from the adopter's installed packages.
    // Uses variable-based import() so TypeScript doesn't resolve against canopycms's own deps.
    const authMode = process.env.CANOPY_AUTH_MODE || 'dev'
    let authPlugin: AuthPlugin | undefined
    try {
      if (authMode === 'clerk') {
        const pkg = 'canopycms-auth-clerk'
        const { createClerkAuthPlugin } = await import(pkg)
        authPlugin = createClerkAuthPlugin({})
      } else if (authMode === 'dev') {
        const pkg = 'canopycms-auth-dev'
        const { createDevAuthPlugin } = await import(pkg)
        authPlugin = createDevAuthPlugin()
      }
    } catch {
      console.warn(`Could not load auth plugin for mode "${authMode}" — skipping cache refresh`)
    }
    await workerRunOnce({ projectDir: process.cwd(), authPlugin })
  } else if (command === 'generate-ai-content') {
    const { generateAIContentCLI } = await import('./generate-ai-content')
    await generateAIContentCLI({
      projectDir: process.cwd(),
      outputDir: typeof flags['output'] === 'string' ? flags['output'] : undefined,
      configPath: typeof flags['config'] === 'string' ? flags['config'] : undefined,
      appDir: typeof flags['app-dir'] === 'string' ? flags['app-dir'] : undefined,
    })
  } else if (command === 'sync') {
    const { sync } = await import('./sync')
    const pushOnly = flags['push'] === true
    const pullOnly = flags['pull'] === true
    const direction = pushOnly ? 'push' : pullOnly ? 'pull' : 'both'
    await sync({
      projectDir: process.cwd(),
      direction,
      branch: typeof flags['branch'] === 'string' ? flags['branch'] : undefined,
      contentRoot: typeof flags['content-root'] === 'string' ? flags['content-root'] : undefined,
    })
  } else {
    console.log('CanopyCMS CLI')
    console.log('')
    console.log('Commands:')
    console.log('  init                    Add CanopyCMS to a Next.js app')
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
    console.log('    --app-dir <path>      App directory (default: app)')
    console.log('')
    console.log('  sync                    Sync content between working tree and CMS')
    console.log('    --push                Push working-tree content to the local remote')
    console.log('    --pull                Pull published content from a branch workspace')
    console.log('    --branch <name>       Branch workspace to pull from')
    console.log('    --content-root <path> Content directory (default: content)')
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
