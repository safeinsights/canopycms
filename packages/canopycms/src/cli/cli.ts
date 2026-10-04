#!/usr/bin/env tsx

/**
 * CanopyCMS CLI entrypoint.
 *
 * Routes commands to their implementations:
 *   init, init-deploy, init-github-app, worker, generate-ai-content, sync, migrate
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
import type { MigrateFormat } from './migrate'

/** Parse raw CLI args into structured flags and positional command. Exported for testing. */
export function parseArgs(rawArgs: string[]) {
  const argv = minimist(rawArgs, {
    boolean: ['force', 'non-interactive', 'dry-run', 'key-stdin'],
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
      'owner',
      'repo',
      'name',
      'app-id',
      'key-out',
      'key-file',
    ],
    // Preserves `-- <command> [args…]` as init-github-app's private-key destination:
    // without it, minimist folds those words into `argv._` and discards the `--`,
    // indistinguishable from the command's own positionals. No other command uses `--`.
    '--': true,
    // --dual-build stays undeclared (not in `boolean:`): a declared boolean flag
    // defaults to `false` when absent, collapsing "not passed" into "explicitly
    // disabled". Undeclared, it parses to true/false/undefined — the tri-state
    // init() needs to choose between a preset and its own prompt/default.
    alias: { f: 'force' },
  })
  const flags = argv as Record<string, string | boolean>
  const command = argv._[0] as string | undefined
  return { argv, flags, command }
}

/**
 * The argv after a literal `--`, as a real string array. minimist types its
 * parsed object with an `any` index signature, so this narrows through
 * `unknown` and returns `[]` when absent, letting callers treat "no
 * passthrough" and "empty passthrough" alike. Exported for testing.
 */
export function passthroughArgs(argv: Record<string, unknown>): string[] {
  const raw: unknown = argv['--']
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string')
}

const AUTH_PROVIDERS = ['clerk', 'dev'] as const

/**
 * Validates --auth for `init`. Undefined means "not passed" (caller falls
 * through to prompt/default); throws if a value is given but unrecognized.
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
 * Validates/coerces --dual-build for `init`. minimist leaves it undeclared (see
 * parseArgs above), so `--dual-build=true` / `--dual-build true` parse as the
 * STRINGS "true"/"false" rather than booleans — coerced explicitly so they don't
 * fall through to `undefined` (then `false` in non-interactive mode), the
 * opposite of what was asked. Undefined means "not passed" (falls through to
 * init()'s own prompt/default); throws on any other non-boolean value.
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
 * Resolves the project root via findProjectRoot (./project-root), or exits
 * with an error when cwd is not inside a CanopyCMS project.
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

/** The auth modes `worker run-once` knows how to build a plugin for. */
export const KNOWN_AUTH_MODES = ['clerk', 'dev'] as const

export type KnownAuthMode = (typeof KNOWN_AUTH_MODES)[number]

/**
 * Whether `CANOPY_AUTH_MODE` names a provider the CLI can actually construct.
 *
 * The dispatch below recognizes only 'clerk' and 'dev', and the plugin-load
 * catch fires only on an import failure — so an unrecognized mode MUST be
 * refused here, or it silently selects no plugin, skips the auth refresh,
 * and exits 0.
 */
export function isKnownAuthMode(value: string): value is KnownAuthMode {
  return (KNOWN_AUTH_MODES as readonly string[]).includes(value)
}

/** Resolve sync subcommand from positional arg. Returns null if missing or invalid. Exported for testing. */
export function resolveSyncSubcommand(sub: string | undefined): SyncSubcommand | null {
  if (sub && (SYNC_SUBCOMMANDS as readonly string[]).includes(sub)) return sub as SyncSubcommand
  return null
}

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
  } else if (command === 'init-github-app') {
    const { initGitHubApp } = await import('./init-github-app')
    const mode = argv._[1]
    if (mode !== 'create' && mode !== 'verify') {
      console.error('Usage: canopycms init-github-app <create|verify> [options]')
      console.error('  create   Register the App from a manifest and capture its private key')
      console.error("  verify   Read an existing App's installation back. Changes nothing")
      process.exit(1)
    }

    const keyOut = typeof flags['key-out'] === 'string' ? flags['key-out'] : undefined
    const passthrough = passthroughArgs(argv)
    // Exactly one destination, refused here rather than after the App exists.
    // Both would leave it undefined which one holds the key that matters.
    if (keyOut && passthrough.length > 0) {
      console.error(
        'Pass either --key-out <path> or `-- <command>`, not both — the private key goes to ' +
          'one destination.',
      )
      process.exit(1)
    }
    const destination = keyOut
      ? ({ kind: 'file', filePath: keyOut } as const)
      : passthrough.length > 0
        ? ({ kind: 'command', argv: passthrough } as const)
        : undefined

    // Key INPUTS (--key-file/--key-stdin) belong to `verify` only; `create` produces
    // the key rather than being given one. Gated on mode because `create --key-stdin`
    // would consume stdin here, leaving `create`'s "press Enter once installed" prompt
    // reading an already-ended stream — it would return instantly, before the App is
    // actually installed.
    let privateKey: string | undefined
    const keyFile = typeof flags['key-file'] === 'string' ? flags['key-file'] : undefined
    if (mode === 'verify') {
      if (keyFile) {
        const { readFile } = await import('node:fs/promises')
        privateKey = await readFile(keyFile, 'utf8')
      } else if (flags['key-stdin'] === true) {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
        privateKey = Buffer.concat(chunks).toString('utf8')
      }
    } else if (keyFile || flags['key-stdin'] === true) {
      console.error(
        '--key-file and --key-stdin are for `verify`, which reads an existing App back.\n' +
          '  `create` produces a new key; say where it should GO with --key-out <path> or ' +
          '`-- <command>`.',
      )
      process.exit(1)
    }

    process.exitCode = await initGitHubApp({
      mode,
      projectDir: process.cwd(),
      owner: typeof flags['owner'] === 'string' ? flags['owner'] : undefined,
      repo: typeof flags['repo'] === 'string' ? flags['repo'] : undefined,
      name: typeof flags['name'] === 'string' ? flags['name'] : undefined,
      appId: typeof flags['app-id'] === 'string' ? flags['app-id'] : undefined,
      destination,
      privateKey,
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
      format: typeof flags['format'] === 'string' ? (flags['format'] as MigrateFormat) : undefined,
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
    console.log('  init-github-app <mode>  Register the GitHub App the worker publishes as')
    console.log('    create                Create it from a manifest, capture its private key')
    console.log('    verify                Read an existing App back. Changes nothing')
    console.log('    --owner/--repo <x>    Target repository (default: detected from origin)')
    console.log('    --name <name>         App display name (default: "<repo> CanopyCMS")')
    console.log('    --key-out <path>      create: write the key to a new file, mode 0600')
    console.log('    -- <command> [args]   create: pipe the key into a command on its stdin')
    console.log("    --app-id <id>         verify: the App's numeric id")
    console.log('    --key-file <path>     verify: read the key from a file')
    console.log('    --key-stdin           verify: read the key from standard input')
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
