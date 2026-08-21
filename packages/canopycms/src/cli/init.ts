import fs from 'node:fs/promises'
import path from 'node:path'
import * as p from '@clack/prompts'
import { createJiti } from 'jiti'
import { operatingStrategy } from '../operating-mode'
import { assertAuthPluginAllowedForMode, type AuthPlugin } from '../auth/plugin'
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
 * The first of `candidates` that exists under `projectDir`, as a bare
 * filename, or null. Order is the caller's: for Next config files it must be
 * Next's own resolution order.
 */
async function firstExistingPath(projectDir: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await filePathExists(path.join(projectDir, candidate))) return candidate
  }
  return null
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
    await canopyCmsConfig({ mode, staticBuild }),
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
    // Use serverRouteExt: a dynamic route handler in the static export build breaks output:'export'
    await writeFile(
      path.join(projectDir, appDir, `ai/[...path]/${serverRouteExt}`),
      await aiRoute({ configImport: configImportPath(appDir, 2) }),
      writeOpts,
    )
  }
  // Next resolves exactly ONE config, in the fixed order next.config.js,
  // .mjs, .ts -- first match wins. Writing next.config.ts beside an existing
  // .js/.mjs therefore produces a file Next silently never loads, taking
  // `withCanopy` with it: no `/assets/:path*` rewrite (media URLs 404), no
  // `transpilePackages`, and for --dual-build no `pageExtensions` split and no
  // `output: 'export'`/'standalone' switching -- so `CANOPY_BUILD=static`
  // quietly produces a normal server build WITH the editor in it. Nothing in
  // the build output names the cause.
  //
  // Mirrors initDeployAws's own probe, which already knows configs come as
  // .mjs too.
  const existingJsConfig = await firstExistingPath(projectDir, [
    'next.config.js',
    'next.config.mjs',
    'next.config.cjs',
  ])
  if (existingJsConfig) {
    p.note(
      [
        `Found ${existingJsConfig}, which Next loads in preference to next.config.ts.`,
        'Left it untouched rather than writing a second config Next would ignore.',
        '',
        'Wrap your existing config by hand:',
        '',
        "  import { withCanopy } from 'canopycms-next/config'",
        '  export default withCanopy(yourConfig)',
      ].join('\n'),
      'Manual step',
    )
  } else {
    await writeFile(
      path.join(projectDir, 'next.config.ts'),
      await nextConfig({ staticBuild }),
      writeOpts,
    )
  }

  // Next only loads middleware from the PARENT of the app/pages directory
  // (verified in next@15.5.21: build uses `rootDir = path.join(pagesDir ||
  // appDir, '..')`, dev uses getPossibleMiddlewareFilenames on the same).
  // `init` supports multi-segment app dirs -- `--app-dir src/app` is
  // documented -- so a project-root middleware.ts is never loaded there, with
  // no warning from Next or from us. The Clerk variant's `auth.protect()` then
  // silently does nothing: /edit and /api/canopycms/* lose their edge
  // protection, and an unauthenticated visitor loads the editor shell and sees
  // failed API calls instead of a sign-in redirect. The API's own Clerk
  // enforcement still holds, so this is a lost defence-in-depth layer plus
  // broken sign-in UX, not an authz bypass.
  //
  // `path.dirname('app')` is '.', which path.join collapses, so the plain case
  // is unchanged.
  await writeFile(
    path.join(projectDir, path.dirname(appDir), 'middleware.ts'),
    await middleware({ authProvider }),
    writeOpts,
  )

  // Update .gitignore -- creating it when absent.
  //
  // The no-file branch previously did nothing, silently. An adopter running
  // `git init && canopycms init && next dev` then `git add .` commits the
  // entire `.canopy-dev` workspace: full git working trees with their own
  // `.git` directories, which git records as GITLINKS. That produces
  // broken submodule-like entries with no `.gitmodules`, so collaborators
  // cloning get empty directories where the CMS expects working trees --
  // and the embedded-repository warning is easy to miss in a large `git add`.
  // Recovering needs an understanding of gitlinks well beyond this tool's
  // audience.
  const gitignorePath = path.join(projectDir, '.gitignore')
  const CANOPY_GITIGNORE_BLOCK = '# CanopyCMS\n.canopy-dev/\n'
  if (await filePathExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (!content.includes('.canopy-dev')) {
      await fs.appendFile(gitignorePath, `\n${CANOPY_GITIGNORE_BLOCK}`)
      p.log.success('updated: .gitignore')
    }
  } else {
    await writeFile(gitignorePath, CANOPY_GITIGNORE_BLOCK, writeOpts)
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
      ...(staticBuild
        ? [
            '',
            'Dual-build commands:',
            '   CANOPY_BUILD=static npm run build   # public static export',
            '   CANOPY_BUILD=cms npm run build      # CMS server build',
          ]
        : []),
    ].join('\n'),
    'Next steps',
  )

  p.outro('Done!')
}

/**
 * Cloud deployment artifacts: generates everything AWS-specific an adopter
 * needs to deploy -- the container image, the CI workflow, and the CDK app the
 * workflow deploys (cdk.json + infrastructure/).
 *
 * The CDK app is scaffolded rather than left to the adopter because
 * `cdk deploy` with no `--app` resolves through `cdk.json`, and `cdk init`
 * cannot create one here: it refuses to run in a non-empty directory, so there
 * is no one-liner to point an existing app at.
 */
export async function initDeployAws(options: InitDeployOptions): Promise<void> {
  const { projectDir, force, nonInteractive } = options
  const writeOpts = { force, nonInteractive }
  const { dockerfileCms, dockerignore, githubWorkflowCms, cdkJson, cdkApp, cmsStack } =
    await import('./templates')
  const {
    detectPackageManager,
    detectDefaultBranch,
    detectGitHubRepo,
    commandsFor,
    missingCdkDependencies,
    CDK_DEPENDENCIES,
  } = await import('./project-detect')

  p.intro('CanopyCMS init-deploy aws')

  // Detection never fails the command: each of these falls back to the value
  // the templates hardcoded before detection existed, so an npm project on a
  // `main`-default repo gets exactly the output it always got.
  const packageManager = await detectPackageManager(projectDir)
  const pm = commandsFor(packageManager)
  const defaultBranch = await detectDefaultBranch(projectDir)
  const repo = await detectGitHubRepo(projectDir)

  await writeFile(
    path.join(projectDir, 'Dockerfile.cms'),
    await dockerfileCms({ copy: pm.dockerCopy, install: pm.dockerInstall, build: pm.build }),
    writeOpts,
  )
  const dockerignoreWritten = await writeFile(
    path.join(projectDir, '.dockerignore'),
    await dockerignore(),
    writeOpts,
  )
  if (!dockerignoreWritten) {
    p.log.warn(
      'Existing .dockerignore kept — verify it excludes .env* (secrets would otherwise ' +
        'enter the build context) and does NOT exclude vendor/ (needed by the ' +
        'Dockerfile.cms install step with file: deps).',
    )
  }
  await writeFile(
    path.join(projectDir, '.github/workflows/deploy-cms.yml'),
    await githubWorkflowCms({
      defaultBranch,
      lockfile: pm.lockfile,
      ciInstall: pm.ciInstall,
      addDev: pm.addDev,
    }),
    writeOpts,
  )

  // The CDK app itself. Without these three files the generated workflow's
  // `cdk deploy` has nothing to deploy against: `cdk deploy` with no --app
  // requires a cdk.json, and `cdk init` cannot supply one because it refuses
  // to run in a non-empty directory.
  const cdkJsonPath = path.join(projectDir, 'cdk.json')
  const existingCdkJson = (await filePathExists(cdkJsonPath))
    ? await fs.readFile(cdkJsonPath, 'utf-8')
    : null
  const cdkJsonWritten = await writeFile(cdkJsonPath, await cdkJson(), writeOpts)

  await writeFile(
    path.join(projectDir, 'infrastructure/bin/app.ts'),
    await cdkApp({
      githubOwner: repo?.owner ?? 'your-org',
      githubRepo: repo?.repo ?? 'your-docs-site',
    }),
    writeOpts,
  )
  await writeFile(
    path.join(projectDir, 'infrastructure/lib/cms-stack.ts'),
    await cmsStack(),
    writeOpts,
  )

  // An adopter with their own CDK app keeps it (writeFile skips), which leaves
  // the scaffolded infrastructure/ unreachable. Say so: the generated workflow
  // deploys by stack name, so it will fail with "no stacks match" rather than
  // deploying their unrelated stacks, but only this message explains why.
  if (
    !cdkJsonWritten &&
    existingCdkJson &&
    !existingCdkJson.includes('infrastructure/bin/app.ts')
  ) {
    p.log.warn(
      'Existing cdk.json kept, and it does not point at infrastructure/bin/app.ts — the ' +
        'scaffolded CDK app will not be deployed. Either wire CmsStack into your own app ' +
        'entry point, or re-run with --force to replace cdk.json.',
    )
  }

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

  // Yarn is detected and templated, but the two Yarn generations differ in
  // ways a lockfile name cannot settle -- and Berry's PnP linker breaks Next's
  // standalone output tracing outright, which the Dockerfile depends on. Say
  // that plainly rather than let a green scaffold imply a tested path.
  if (packageManager === 'yarn' || packageManager === 'yarn-berry') {
    p.log.warn(
      `Yarn detected (${packageManager === 'yarn-berry' ? 'Berry' : 'classic'}). The generated ` +
        'install lines are a best effort and are not exercised by CanopyCMS tests — review them ' +
        'in Dockerfile.cms and .github/workflows/deploy-cms.yml.' +
        (packageManager === 'yarn-berry'
          ? ' Berry additionally requires nodeLinker: node-modules; PnP is incompatible with ' +
            "Next.js standalone output, which the CMS image's runner stage copies."
          : ''),
    )
  }

  const missing = await missingCdkDependencies(projectDir)
  if (missing.length > 0) {
    // A generic "install the CDK packages" note is what let the previous gap
    // ship. Name the ones this project is actually missing.
    p.log.warn(
      `Not installed: ${missing.join(', ')}. cdk.json runs ` +
        '`node --import tsx infrastructure/bin/app.ts`, so the deploy fails without them:\n' +
        `   ${pm.addDev} ${CDK_DEPENDENCIES.join(' ')}`,
    )
  }

  p.note(
    [
      '1. Install the CDK dependencies (if you have not already):',
      `   ${pm.addDev} ${CDK_DEPENDENCIES.join(' ')}`,
      '',
      '2. Fill in infrastructure/lib/cms-stack.ts and infrastructure/bin/app.ts',
      `   (worker repo currently set to ${repo ? `${repo.owner}/${repo.repo}` : 'your-org/your-docs-site'})`,
      '',
      '3. Bootstrap CDK in the target account/region: cdk bootstrap',
      '',
      '4. Set the repository secrets and variables listed at the top of',
      '   .github/workflows/deploy-cms.yml — the deploy fails at synth without them.',
      '',
      `Deploys trigger on pushes to '${defaultBranch}'; edit the workflow to change that.`,
      '',
      'Full walkthrough: docs/deploying-to-aws.md',
    ].join('\n'),
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
 * Since `mode` is now schema-required (no default — SEC-C1), a config file that omits
 * it fails Zod validation inside defineCanopyConfig at import time; that surfaces here
 * as a jiti-import failure, caught and re-thrown loudly below rather than silently
 * treated as absent.
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

  // Fail closed (SEC-C1): never populate a prod auth cache from a dev/insecure plugin.
  if (options.authPlugin) {
    assertAuthPluginAllowedForMode(options.authPlugin, mode)
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

  // Refresh auth cache. A refresh failure (e.g. CLERK_SECRET_KEY missing —
  // the Clerk plugin resolves it lazily at refresh time, not at construction)
  // must be loud but must not abort the run: task draining below publishes
  // content and is independent of the auth cache. Exit non-zero so
  // orchestration still notices the stale/missing cache.
  if (refreshAuthCache) {
    console.log('Refreshing auth cache...')
    try {
      await refreshAuthCache()
      console.log('Auth cache refreshed')
    } catch (err) {
      console.error(`Auth cache NOT refreshed: ${getErrorMessage(err)}`)
      process.exitCode = 1
    }
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
