#!/usr/bin/env tsx

/**
 * CanopyCMS CLI entrypoint.
 *
 * Routes commands to their implementations:
 *   init, init-deploy, worker, generate-ai-content, sync, migrate
 *
 * Command implementations live in separate files (init.ts, sync.ts, etc.)
 * and are dynamically imported to keep startup fast.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import minimist from 'minimist'
import * as p from '@clack/prompts'
import type { AuthPlugin } from '../auth/plugin'
import type { AuthProvider } from './init'
import { getErrorMessage } from '../utils/error'

/** Parse raw CLI args into structured flags and positional command. Exported for testing. */
export function parseArgs(rawArgs: string[]) {
  const argv = minimist(rawArgs, {
    boolean: ['force', 'non-interactive', 'dry-run'],
    string: [
      'app-dir',
      'branch',
      'content-root',
      'output',
      'config',
      'entry-type',
      'format',
      'schema',
      'auth',
    ],
    // --dual-build is intentionally NOT declared boolean here: minimist defaults
    // declared-boolean flags to `false` when absent, which would make "not passed"
    // indistinguishable from "explicitly disabled". Left undeclared, it parses to
    // `true` when passed bare, `false` via the standard `--no-dual-build` negation,
    // and stays `undefined` when omitted entirely — exactly the tri-state init()
    // needs to decide whether to honor a preset or fall through to prompt/default.
    alias: { f: 'force' },
  })
  const flags = argv as Record<string, string | boolean>
  const command = argv._[0] as string | undefined
  return { argv, flags, command }
}

const AUTH_PROVIDERS = ['clerk', 'dev'] as const

/**
 * Validate the --auth flag value for `init`. Returns undefined when the flag
 * was not provided (caller should fall through to interactive prompt / default).
 * Throws when a value was provided but isn't a recognized auth provider.
 * Exported for testing.
 */
export function parseAuthFlag(value: string | boolean | undefined): AuthProvider | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && (AUTH_PROVIDERS as readonly string[]).includes(value)) {
    return value as AuthProvider
  }
  throw new Error(`--auth must be "clerk" or "dev", got "${String(value)}"`)
}

/**
 * Validate/coerce the --dual-build flag value for `init`. Returns undefined
 * when the flag was not provided (caller should fall through to init()'s own
 * prompt-or-default logic). minimist leaves `dual-build` undeclared (see
 * parseArgs above), so `--dual-build=true` / `--dual-build true` parse as the
 * STRINGS "true"/"false" rather than real booleans — coerce those explicitly
 * so they don't silently fall through to `undefined` (then `false` by
 * default in non-interactive mode), the opposite of what the user asked.
 * Throws when a value was provided but isn't a real boolean or "true"/"false".
 * Exported for testing.
 */
export function parseDualBuildFlag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`--dual-build must be a boolean (true/false), got "${String(value)}"`)
}

const SYNC_SUBCOMMANDS = ['push', 'pull', 'both', 'abort'] as const
type SyncSubcommand = (typeof SYNC_SUBCOMMANDS)[number]

/**
 * Resolve the project root for commands that need an existing CanopyCMS
 * project, walking up from cwd to the nearest canopycms.config.ts.
 * Exits with an error when not inside a project.
 */
async function requireProjectRoot(command: string): Promise<string> {
  const { findProjectRoot, PROJECT_MARKER } = await import('./project-root')
  const root = await findProjectRoot(process.cwd())
  if (!root) {
    console.error(
      `Error: "canopycms ${command}" must run inside a CanopyCMS project — ` +
        `no ${PROJECT_MARKER} found in ${process.cwd()} or any parent directory.`,
    )
    process.exit(1)
  }
  if (root !== process.cwd()) {
    console.log(`Using project root: ${root}`)
  }
  return root
}

/** Resolve sync subcommand from positional arg. Returns null if missing or invalid. Exported for testing. */
/** The auth modes `worker run-once` knows how to build a plugin for. */
export const KNOWN_AUTH_MODES = ['clerk', 'dev'] as const

export type KnownAuthMode = (typeof KNOWN_AUTH_MODES)[number]

/**
 * Whether `CANOPY_AUTH_MODE` names a provider the CLI can actually construct.
 *
 * Pure and exported so it is testable: the dispatch below branches on 'clerk'
 * and 'dev' only, and the catch around plugin loading fires solely on an
 * IMPORT failure -- so before this guard existed, any other value (a typo,
 * wrong casing like 'Clerk', a stale value from another system) selected no
 * plugin, skipped the auth refresh entirely, and let the command run to "Done"
 * with exit code 0. A cron'd `CANOPY_AUTH_MODE=clerk canopycms worker
 * run-once` that became `Clerk` refreshed nothing for as long as the typo
 * survived, while the cache aged and a user removed from the Clerk org kept
 * editor access.
 */
export function isKnownAuthMode(value: string): value is KnownAuthMode {
  return (KNOWN_AUTH_MODES as readonly string[]).includes(value)
}

export function resolveSyncSubcommand(sub: string | undefined): SyncSubcommand | null {
  if (sub && (SYNC_SUBCOMMANDS as readonly string[]).includes(sub)) return sub as SyncSubcommand
  return null
}

// CLI entrypoint
async function main() {
  const { argv, flags, command } = parseArgs(process.argv.slice(2))

  if (command === 'init') {
    const { init } = await import('./init')
    const nonInteractive = flags['non-interactive'] === true
    const force = flags['force'] === true

    const mode = 'dev'

    let authProvider: AuthProvider | undefined
    try {
      authProvider = parseAuthFlag(flags['auth'])
    } catch (err) {
      console.error(`Error: ${getErrorMessage(err)}`)
      process.exit(1)
    }

    // Tri-state: undefined (flag omitted) falls through to init()'s own
    // prompt-or-default logic; true/false (flag or --no-dual-build passed)
    // presets the choice and skips the prompt, same as authProvider above.
    let staticBuild: boolean | undefined
    try {
      staticBuild = parseDualBuildFlag(flags['dual-build'])
    } catch (err) {
      console.error(`Error: ${getErrorMessage(err)}`)
      process.exit(1)
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
    if (flags['ai'] === false) {
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
      authProvider,
      staticBuild,
    })
  } else if (command === 'init-deploy') {
    const { initDeployAws } = await import('./init')
    const cloud = argv._[1]
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
    const subcommand = argv._[1]
    if (subcommand !== 'run-once') {
      console.error('Usage: canopycms worker run-once')
      process.exit(1)
    }
    // Resolve auth plugin from the adopter's installed packages.
    // Uses variable-based import() so TypeScript doesn't resolve against canopycms's own deps.
    const authMode = process.env.CANOPY_AUTH_MODE || 'dev'
    // Validate BEFORE dispatch. The branch below only knows 'clerk' and 'dev',
    // so any other value -- a typo, wrong casing like 'Clerk', a stale value
    // from another system -- selected no plugin at all, and the catch below
    // only fires on an import FAILURE, so nothing warned. workerRunOnce then
    // skipped the auth refresh entirely and the command ran to "Done" with
    // exit code 0: a cron'd `CANOPY_AUTH_MODE=clerk canopycms worker run-once`
    // would refresh nothing for as long as the typo survived, while the cache
    // aged indefinitely and a user removed from the Clerk org kept editor
    // access. The non-zero exit that already exists for refresh FAILURES never
    // fired, because nothing failed.
    if (!isKnownAuthMode(authMode)) {
      console.error(
        `Unknown CANOPY_AUTH_MODE "${authMode}" — expected one of: ${KNOWN_AUTH_MODES.join(', ')}. ` +
          `No auth plugin was loaded, so the auth cache will NOT be refreshed.`,
      )
      process.exitCode = 1
    }
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
    await workerRunOnce({ projectDir: await requireProjectRoot('worker run-once'), authPlugin })
  } else if (command === 'generate-ai-content') {
    const { generateAIContentCLI } = await import('./generate-ai-content')
    await generateAIContentCLI({
      projectDir: await requireProjectRoot('generate-ai-content'),
      outputDir: typeof flags['output'] === 'string' ? flags['output'] : undefined,
      configPath: typeof flags['config'] === 'string' ? flags['config'] : undefined,
      appDir: typeof flags['app-dir'] === 'string' ? flags['app-dir'] : undefined,
    })
  } else if (command === 'sync') {
    const direction = resolveSyncSubcommand(argv._[1] as string | undefined)
    if (!direction) {
      console.log('Usage: canopycms sync <command> [options]')
      console.log('')
      console.log('Commands:')
      console.log('  push    Push working-tree content to a branch workspace')
      console.log('  pull    Pull content from a branch workspace')
      console.log('  both    3-way merge between working tree and workspace')
      console.log('  abort   Abort a failed merge in a branch workspace')
      console.log('')
      console.log('Options:')
      console.log('  --branch <name>       Target branch workspace')
      console.log('  --content-root <path> Content directory (default: content)')
      console.log('  --force               Skip confirmation prompts')
      process.exit(argv._[1] ? 1 : 0)
    }
    const { sync } = await import('./sync')
    await sync({
      projectDir: await requireProjectRoot(`sync ${direction}`),
      direction,
      branch: typeof flags['branch'] === 'string' ? flags['branch'] : undefined,
      contentRoot: typeof flags['content-root'] === 'string' ? flags['content-root'] : undefined,
      force: flags['force'] === true,
    })
  } else if (command === 'migrate') {
    const { migrate } = await import('./migrate')
    await migrate({
      projectDir: await requireProjectRoot('migrate'),
      contentRoot: typeof flags['content-root'] === 'string' ? flags['content-root'] : undefined,
      entryType: typeof flags['entry-type'] === 'string' ? flags['entry-type'] : undefined,
      format:
        typeof flags['format'] === 'string'
          ? (flags['format'] as import('./migrate').MigrateFormat)
          : undefined,
      schema: typeof flags['schema'] === 'string' ? flags['schema'] : undefined,
      dryRun: flags['dry-run'] === true,
      force: flags['force'] === true,
    })
  } else {
    console.log('CanopyCMS CLI')
    console.log('')
    console.log('Commands:')
    console.log('  init                    Add CanopyCMS to a Next.js app')
    console.log('    --app-dir <path>      App directory (default: app)')
    console.log('    --no-ai               Skip AI content endpoint generation')
    console.log('    --auth <provider>     Auth provider: clerk|dev (default: dev)')
    console.log('    --dual-build          Enable static+CMS dual-build output')
    console.log('    --force               Overwrite existing files without asking')
    console.log('    --non-interactive     Use defaults, no prompts')
    console.log(
      '                          (--auth/--dual-build apply in both modes and skip their prompt)',
    )
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
    console.log('  sync <command>          Sync content between working tree and CMS')
    console.log('    push                  Push working-tree content to a branch workspace')
    console.log('    pull                  Pull content from a branch workspace')
    console.log('    both                  3-way merge between working tree and workspace')
    console.log('    abort                 Abort a failed merge in a branch workspace')
    console.log('')
    console.log(
      '  migrate                 Convert an existing content tree to CanopyCMS conventions',
    )
    console.log('    --content-root <path> Content directory (default: content)')
    console.log('    --entry-type <name>   Entry type name (e.g. doc)')
    console.log('    --format <fmt>        File format to migrate: md|mdx|json|yaml')
    console.log('    --schema <key>        Entry schema registry key (e.g. docSchema)')
    console.log('    --dry-run             Print the plan without changing anything')
    console.log('    --force               Skip confirmation prompts')
    process.exit(0)
  }
}

// Only run when executed directly as a CLI, not when imported in tests.
// Use realpathSync to resolve symlinks — npx creates a symlink in node_modules/.bin/
// that won't match import.meta.url's resolved real path.
const __filename = fileURLToPath(import.meta.url)
let isDirectRun = false
try {
  isDirectRun = realpathSync(process.argv[1]) === realpathSync(__filename)
} catch {
  // process.argv[1] may be undefined or point to a non-existent file
}

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error:', getErrorMessage(err))
    process.exit(1)
  })
}
