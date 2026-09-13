/**
 * End-to-end check that `canopycms init-deploy aws` emits a CDK project that
 * actually synthesizes.
 *
 * This exists because template-string assertions are what let the previous gap
 * ship: the generated workflow ran `cdk deploy` from a repo root that had no
 * `cdk.json`, and every test asserting on file *contents* passed anyway. So
 * this one asserts on behaviour instead -- it runs the real CLI, then runs the
 * `app` command out of the `cdk.json` that CLI generated, and requires a
 * CloudFormation template to come out the other end.
 *
 * Why this test lives in `canopycms-cdk` rather than next to the CLI it
 * exercises: the synth needs `aws-cdk-lib`, `constructs` and a resolvable
 * `canopycms-cdk`, and this is the only package where all three are present.
 * The scaffold directory is created *inside* this package and deliberately
 * given no `package.json` of its own, which is what lets Node resolve
 * `canopycms-cdk` from the generated stack by walking up to this package's own
 * manifest (self-reference, via its `exports` field).
 *
 * Known limits, so nobody reads more into a green run than is there:
 *   - It resolves the workspace `src/`, not the published tarball. Packaging
 *     regressions are covered by `init.integration.test.ts` and by the
 *     `files`/`prepack` contract in package.json.
 *   - It stops at synth. No Docker image is ever built, so the Dockerfile's
 *     install/build lines -- including the pnpm variants -- are not exercised
 *     here by anything.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Manifest } from 'aws-cdk-lib/cloud-assembly-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

// This file sits at packages/canopycms-cdk/src/, so the package root is one up
// and the workspace root three.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.join(__dirname, '..')
const WORKSPACE_ROOT = path.join(PACKAGE_ROOT, '..', '..')
const CLI_ENTRY = path.join(WORKSPACE_ROOT, 'packages', 'canopycms', 'src', 'cli', 'cli.ts')

/**
 * Scratch projects live at the package root, never under `src/`: this
 * package's lint glob (`eslint src/ ...`) and tsconfig `include` both cover
 * `src/`, so a crashed run that skipped cleanup would otherwise start failing
 * `pnpm lint` and `pnpm typecheck` with generated files.
 */
const SCAFFOLD_PARENT = path.join(PACKAGE_ROOT, '.scaffold-synth')

/** The worker bundle `CanopyCmsService` stages as an S3 asset during synth. */
const WORKER_DIST = path.join(PACKAGE_ROOT, 'worker', 'dist')

/**
 * Placeholder values for the variables the generated `bin/app.ts` refuses to
 * synth without. Shapes matter: `fromSecretCompleteArn` validates that its
 * argument is a full ARN, so a bare string would fail for the wrong reason.
 */
const SYNTH_ENV = {
  GITHUB_TOKEN_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:111111111111:secret:canopycms/github-token-Ab12Cd',
  CLERK_SECRET_KEY_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:111111111111:secret:canopycms/clerk-secret-key-Ef34Gh',
  CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----',
}

/** Two cold Node boots, one of which imports all of aws-cdk-lib and stages two assets. */
const TIMEOUT_MS = 120_000

let scaffoldDir: string
let appCommand: string
let synthesizedStacks: string[]
let resourceTypes: Set<string>
/** Every resource in every synthesized template, so assertions can look inside them. */
let resources: unknown[]

function readJsonField(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null && field in value
    ? (value as Record<string, unknown>)[field]
    : undefined
}

beforeAll(async () => {
  // Fail loudly rather than skip. A skip here would restore exactly the
  // property this test exists to remove: a suite that goes green without
  // checking the thing.
  if (!existsSync(WORKER_DIST)) {
    throw new Error(
      `The worker bundle at ${WORKER_DIST} is missing, so CanopyCmsService cannot stage its ` +
        'asset and this test cannot synth. Build it:\n' +
        '  pnpm --filter canopycms-cdk run build:test-fixtures',
    )
  }

  await fs.mkdir(SCAFFOLD_PARENT, { recursive: true })
  // mkdtemp, so two concurrent runs cannot land in the same directory.
  scaffoldDir = await fs.mkdtemp(path.join(SCAFFOLD_PARENT, 'project-'))

  // 1. The genuine adopter path: the real CLI, not a re-implementation of what
  //    it is supposed to write. `init` FIRST, matching docs/deploying-to-aws.md's
  //    documented order (`npx canopycms init` before `npx canopycms init-deploy
  //    aws`) -- the generated infrastructure/lib/cms-stack.ts now imports the
  //    project's own canopycms.config.ts at synth time (to derive
  //    baseBranch/settingsBranch without risking drift from a hand-copied
  //    literal), so without this step the synth below would fail with
  //    ERR_MODULE_NOT_FOUND on every real adopter's behalf.
  await execFileAsync(
    process.execPath,
    ['--import', 'tsx', CLI_ENTRY, 'init', '--non-interactive', '--force'],
    { cwd: scaffoldDir, timeout: TIMEOUT_MS },
  )
  await execFileAsync(
    process.execPath,
    ['--import', 'tsx', CLI_ENTRY, 'init-deploy', 'aws', '--non-interactive', '--force'],
    { cwd: scaffoldDir, timeout: TIMEOUT_MS },
  )

  const cdkJson: unknown = JSON.parse(
    await fs.readFile(path.join(scaffoldDir, 'cdk.json'), 'utf-8'),
  )
  const app = readJsonField(cdkJson, 'app')
  if (typeof app !== 'string') throw new Error('generated cdk.json has no string `app` command')
  appCommand = app

  // 2. Run that command verbatim -- whatever it says, not what this test
  //    assumes it says. `CDK_OUTDIR` is how the CDK CLI asks an App to
  //    auto-synth, and `CDK_CONTEXT_JSON` is how it delivers cdk.json's
  //    `context`. Passing the context matters: a stale CDKv1 feature flag left
  //    in that block is rejected at synth (UnsupportedFeatureFlag), and
  //    without this the test would sail straight past it.
  await execFileAsync('sh', ['-c', appCommand], {
    cwd: scaffoldDir,
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      ...SYNTH_ENV,
      // Must stay literally `cdk.out`: the scaffolded .dockerignore excludes
      // that exact name, and the stack stages the project directory as a
      // Docker image asset. Under any other name, synth output would be copied
      // into the very asset it is producing.
      CDK_OUTDIR: 'cdk.out',
      CDK_CONTEXT_JSON: JSON.stringify(readJsonField(cdkJson, 'context') ?? {}),
    },
  })

  const outDir = path.join(scaffoldDir, 'cdk.out')
  const templateFiles = (await fs.readdir(outDir)).filter((f) => f.endsWith('.template.json'))
  synthesizedStacks = templateFiles.map((f) => f.replace('.template.json', ''))

  resourceTypes = new Set()
  resources = []
  for (const file of templateFiles) {
    const template: unknown = JSON.parse(await fs.readFile(path.join(outDir, file), 'utf-8'))
    const templateResources = readJsonField(template, 'Resources')
    if (typeof templateResources !== 'object' || templateResources === null) continue
    for (const resource of Object.values(templateResources)) {
      resources.push(resource)
      const type = readJsonField(resource, 'Type')
      if (typeof type === 'string') resourceTypes.add(type)
    }
  }
}, TIMEOUT_MS)

afterAll(async () => {
  if (scaffoldDir) await fs.rm(scaffoldDir, { recursive: true, force: true })
})

describe('canopycms init-deploy aws produces a synthesizable CDK app', () => {
  it('synthesizes exactly one stack through the generated cdk.json', () => {
    expect(appCommand).toContain('infrastructure/bin/app.ts')
    expect(synthesizedStacks).toHaveLength(1)
  })

  it('emits the resources a CanopyCMS deployment cannot work without', () => {
    // The CMS Lambda, the EFS filesystem it and the worker both mount, and the
    // worker's Auto Scaling Group.
    expect(resourceTypes).toContain('AWS::Lambda::Function')
    expect(resourceTypes).toContain('AWS::EFS::FileSystem')
    expect(resourceTypes).toContain('AWS::AutoScaling::AutoScalingGroup')
  })

  /**
   * Baseline review E4. The generated project used to ship a dev-mode
   * deployment: `canopycms init` bakes `mode: 'dev'` into
   * canopycms.config.ts (correctly -- `next dev` and the image build both need
   * it), and nothing supplied a deployed value, so the Lambda resolved its
   * workspace to `<cwd>/.canopy-dev` and died with EROFS on Lambda's read-only
   * filesystem. This asserts on the artifact the CLI actually emits, end to
   * end, rather than on any single file's contents.
   */
  it('deploys a prod-mode CMS: CANOPY_MODE on the Lambda, NEXT_PUBLIC_CANOPY_MODE in the image build', async () => {
    const cmsFunctions = resources.filter((resource) => {
      if (readJsonField(resource, 'Type') !== 'AWS::Lambda::Function') return false
      const variables = readJsonField(readJsonField(resource, 'Properties'), 'Environment')
      return readJsonField(variables, 'Variables') !== undefined
    })
    expect(cmsFunctions.length).toBeGreaterThan(0)

    // The server half, read at run time by resolveOperatingMode.
    for (const fn of cmsFunctions) {
      const variables = readJsonField(
        readJsonField(readJsonField(fn, 'Properties'), 'Environment'),
        'Variables',
      )
      expect(readJsonField(variables, 'CANOPY_MODE')).toBe('prod')
    }

    // The browser half. The editor page is a client component importing the
    // adopter's config, so its `mode` is whatever was inlined at build time --
    // a Lambda environment variable is far too late. Asserted on the generated
    // stack source because Docker build args live in the CDK asset manifest,
    // not in the CloudFormation template.
    const stackSource = await fs.readFile(
      path.join(scaffoldDir, 'infrastructure/lib/cms-stack.ts'),
      'utf-8',
    )
    expect(stackSource).toContain("NEXT_PUBLIC_CANOPY_MODE: 'prod'")

    // The image itself must NOT bake the server half in: `next build` runs its
    // content reads in dev mode, and a prod-mode build read would look for a
    // branch workspace that cannot exist in a builder. Build arg in, runtime
    // variable out -- that pairing is the whole mechanism.
    const dockerfile = await fs.readFile(path.join(scaffoldDir, 'Dockerfile.cms'), 'utf-8')
    expect(dockerfile).toContain('ARG NEXT_PUBLIC_CANOPY_MODE')
    expect(dockerfile).not.toContain('ENV CANOPY_MODE=prod')
  })

  /**
   * The load-bearing half of adopter request #39. The generated stack imports
   * the project's own `canopycms.config.ts` and derives
   * `baseBranch`/`settingsBranch` from it, so that the worker's `.env` and the
   * Lambda's request-time config cannot disagree. Synthesizing successfully
   * only proves the IMPORT resolves; this proves the VALUES travel, which is
   * the thing that was broken.
   *
   * Deliberately re-synths against an edited config rather than asserting on
   * the default: with `defaultBaseBranch` unset, the expected stamp is `main`,
   * which is also what the old hardcoded default emitted -- so a test on the
   * default would pass just as well with the bug still in place.
   */
  it(
    'carries a non-default defaultBaseBranch/settingsBranch from canopycms.config.ts into the worker .env',
    async () => {
      const configPath = path.join(scaffoldDir, 'canopycms.config.ts')
      const original = await fs.readFile(configPath, 'utf-8')
      // `mode: 'dev'` is the one field `canopycms init` is known to write; anchor
      // on it so this fails loudly if the scaffolded shape changes, rather than
      // silently inserting nothing.
      expect(original).toContain("mode: 'dev'")
      await fs.writeFile(
        configPath,
        original.replace(
          "mode: 'dev'",
          [
            "mode: 'dev',",
            "  defaultBaseBranch: 'release/v2',",
            "  settingsBranch: 'canopycms-settings-scaffold-probe'",
          ].join('\n'),
        ),
        'utf-8',
      )

      const outDir = 'cdk.out-branch-probe'
      try {
        const cdkJson: unknown = JSON.parse(
          await fs.readFile(path.join(scaffoldDir, 'cdk.json'), 'utf-8'),
        )
        await execFileAsync('sh', ['-c', appCommand], {
          cwd: scaffoldDir,
          timeout: TIMEOUT_MS,
          env: {
            ...process.env,
            ...SYNTH_ENV,
            CDK_OUTDIR: outDir,
            CDK_CONTEXT_JSON: JSON.stringify(readJsonField(cdkJson, 'context') ?? {}),
          },
        })

        const probeDir = path.join(scaffoldDir, outDir)
        const templates = (await fs.readdir(probeDir)).filter((f) => f.endsWith('.template.json'))
        expect(templates).toHaveLength(1)
        // The worker's .env is written by a user-data heredoc, so the values end
        // up as literal substrings of the template rather than as structured
        // fields. Searching the whole template is what makes this robust to how
        // CDK chooses to chunk the UserData Fn::Join.
        const rendered = await fs.readFile(path.join(probeDir, templates[0]), 'utf-8')
        expect(rendered).toContain('CANOPYCMS_BASE_BRANCH=release/v2')
        expect(rendered).toContain('CANOPYCMS_SETTINGS_BRANCH=canopycms-settings-scaffold-probe')
        // And the old behaviour is genuinely gone, not merely accompanied.
        expect(rendered).not.toContain('CANOPYCMS_BASE_BRANCH=main')
      } finally {
        await fs.writeFile(configPath, original, 'utf-8')
        await fs.rm(path.join(scaffoldDir, outDir), { recursive: true, force: true })
      }
    },
    TIMEOUT_MS,
  )

  /**
   * The image's architecture is the platform `cdk deploy` builds it for, and
   * CDK records that platform in the asset manifest, never in the
   * CloudFormation template -- so no template assertion can see a mismatch.
   * Asserting both halves together is what catches one: an image built for
   * the host rather than the function deploys clean and fails at invoke.
   */
  it('builds the CMS image for the architecture its Lambda runs on (linux/arm64)', async () => {
    const outDir = path.join(scaffoldDir, 'cdk.out')
    const manifests = (await fs.readdir(outDir)).filter((f) => f.endsWith('.assets.json'))
    const platforms = manifests.flatMap((file) =>
      Object.values(Manifest.loadAssetManifest(path.join(outDir, file)).dockerImages ?? {}).map(
        (image) => image.source.platform,
      ),
    )
    expect(platforms).toEqual(['linux/arm64'])

    const imageFunctionArchitectures = resources
      .filter(
        (resource) =>
          readJsonField(resource, 'Type') === 'AWS::Lambda::Function' &&
          readJsonField(readJsonField(resource, 'Properties'), 'PackageType') === 'Image',
      )
      .map((fn) => readJsonField(readJsonField(fn, 'Properties'), 'Architectures'))
    expect(imageFunctionArchitectures).toEqual([['arm64']])
  })

  it('names the stack exactly what the generated workflow deploys', async () => {
    // `--all` would deploy any other stacks in the adopter's repo, so the
    // workflow deploys by name. That only works while the two agree, and
    // nothing at runtime would report it if they stopped agreeing -- the
    // deploy would simply fail with "no stacks match".
    const workflow = await fs.readFile(
      path.join(scaffoldDir, '.github/workflows/deploy-cms.yml'),
      'utf-8',
    )
    const deployLine = workflow
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('run: npx cdk deploy'))
    expect(deployLine).toBeDefined()

    const deployedStack = deployLine?.replace('run: npx cdk deploy', '').trim().split(/\s+/)[0]
    expect(deployedStack).not.toBe('--all')
    expect(synthesizedStacks).toContain(deployedStack)
  })
})

/**
 * A tsconfig.json in create-next-app 16.1.7's shape, as `scripts/smoke/standalone-image.mjs` writes
 * one. Its `paths` alias and its `incremental` are both inherited by the generated
 * infrastructure/tsconfig.json, which extends it.
 */
const NEXT_APP_TSCONFIG = {
  compilerOptions: {
    target: 'ES2017',
    lib: ['dom', 'dom.iterable', 'esnext'],
    allowJs: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'react-jsx',
    incremental: true,
    plugins: [{ name: 'next' }],
    paths: { '@/*': ['./*'] },
  },
  include: [
    'next-env.d.ts',
    '**/*.ts',
    '**/*.tsx',
    '.next/types/**/*.ts',
    '.next/dev/types/**/*.ts',
    '**/*.mts',
  ],
  exclude: ['node_modules'],
}

/**
 * The synth above cannot catch a type error: cdk.json runs the app through tsx, which strips types
 * without checking them. So a misspelled `CanopyCmsService` prop synthesizes, and the deploy uses
 * that prop's default. The generated workflow's type-check step is the only check, and these tests
 * run its command, read from the workflow the way `appCommand` is read from cdk.json.
 *
 * They use a scaffold of their own, because the one above has no tsconfig.json and an adopter's
 * Next app does. In this workspace `canopycms` and `canopycms-cdk` resolve to their `src/`, so a
 * failure here can come from those packages' sources as well as from the templates.
 */
describe('the generated workflow type-checks the CDK app', () => {
  let appDir: string

  beforeAll(async () => {
    appDir = await fs.mkdtemp(path.join(SCAFFOLD_PARENT, 'typecheck-'))
    await fs.writeFile(
      path.join(appDir, 'tsconfig.json'),
      `${JSON.stringify(NEXT_APP_TSCONFIG, null, 2)}\n`,
      'utf-8',
    )
    for (const command of [['init'], ['init-deploy', 'aws']]) {
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', CLI_ENTRY, ...command, '--non-interactive', '--force'],
        { cwd: appDir, timeout: TIMEOUT_MS },
      )
    }
  }, TIMEOUT_MS)

  afterAll(async () => {
    if (appDir) await fs.rm(appDir, { recursive: true, force: true })
  })

  async function typeCheckCommand(): Promise<string> {
    const workflow = await fs.readFile(
      path.join(appDir, '.github/workflows/deploy-cms.yml'),
      'utf-8',
    )
    const command = workflow
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('npx tsc '))
    if (!command) throw new Error('generated workflow has no `npx tsc` type-check command')
    return command
  }

  /** tsc prints its diagnostics to stdout, which execFile's rejection message leaves out. */
  async function runInApp(command: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('sh', ['-c', command], {
        cwd: appDir,
        timeout: TIMEOUT_MS,
      })
      return stdout
    } catch (err) {
      throw new Error(`\`${command}\` failed:\n${String(readJsonField(err, 'stdout'))}`)
    }
  }

  it(
    'passes on the scaffold, and checks the CDK app without the rest of the Next app',
    async () => {
      const command = await typeCheckCommand()
      await runInApp(command)

      // Imports are followed, so canopycms.config.ts is checked with the stack that imports it.
      // Nothing else from the project may be: app/, middleware.ts and next.config.ts need the
      // Next app's dependencies.
      const listed = await runInApp(`${command} --listFilesOnly`)
      const projectFiles = listed
        .split('\n')
        .map((file) => path.relative(appDir, file.trim()))
        .filter((file) => file && !file.startsWith('..'))
      expect(projectFiles.sort()).toEqual([
        'canopycms.config.ts',
        'infrastructure/bin/app.ts',
        'infrastructure/lib/cms-stack.ts',
      ])

      // The app's `incremental: true` is inherited unless the generated file turns it off.
      expect(existsSync(path.join(appDir, 'infrastructure/tsconfig.tsbuildinfo'))).toBe(false)
    },
    TIMEOUT_MS,
  )

  it(
    "resolves the app's `paths` aliases, as tsx does",
    async () => {
      const configPath = path.join(appDir, 'canopycms.config.ts')
      const probePath = path.join(appDir, 'alias-probe.ts')
      const original = await fs.readFile(configPath, 'utf-8')
      await fs.writeFile(probePath, "export const aliasProbe = 'probe'\n", 'utf-8')
      // `@/*` is the alias create-next-app configures, and canopycms.config.ts is where an adopter
      // adds imports of their own.
      await fs.writeFile(
        configPath,
        `import { aliasProbe } from '@/alias-probe'\nvoid aliasProbe\n${original}`,
        'utf-8',
      )

      try {
        await runInApp(await typeCheckCommand())
      } finally {
        await fs.writeFile(configPath, original, 'utf-8')
        await fs.rm(probePath, { force: true })
      }
    },
    TIMEOUT_MS,
  )

  it(
    "passes when the app's tsconfig.json sets options tsx does not apply to infrastructure/",
    async () => {
      const rootPath = path.join(appDir, 'tsconfig.json')
      const original = await fs.readFile(rootPath, 'utf-8')
      const root: unknown = JSON.parse(original)
      const compilerOptions = readJsonField(root, 'compilerOptions')
      if (typeof compilerOptions !== 'object' || compilerOptions === null) {
        throw new Error("the scaffold's tsconfig.json has no compilerOptions")
      }
      // Each one, inherited, fails the generated stack, and none of them changes how tsx runs it.
      Object.assign(compilerOptions, {
        verbatimModuleSyntax: true,
        exactOptionalPropertyTypes: true,
        noPropertyAccessFromIndexSignature: true,
        composite: true,
      })
      await fs.writeFile(rootPath, JSON.stringify(root), 'utf-8')

      try {
        await runInApp(await typeCheckCommand())
      } finally {
        await fs.writeFile(rootPath, original, 'utf-8')
        await fs.rm(path.join(appDir, 'infrastructure/tsconfig.tsbuildinfo'), { force: true })
      }
    },
    TIMEOUT_MS,
  )

  it(
    'fails on a misspelled CanopyCmsService prop',
    async () => {
      const stackPath = path.join(appDir, 'infrastructure/lib/cms-stack.ts')
      const original = await fs.readFile(stackPath, 'utf-8')
      // Anchored on a prop the template is known to set, so a change to the template fails here
      // loudly rather than misspelling nothing.
      expect(original).toContain('memorySize: 2048,')
      await fs.writeFile(stackPath, original.replace('memorySize: 2048,', 'memorySzie: 2048,'))

      try {
        // The diagnostic, not just a non-zero exit: a missing tsconfig.json fails too.
        await expect(runInApp(await typeCheckCommand())).rejects.toThrow(
          /error TS2561: .*'memorySzie' does not exist in type 'CanopyCmsServiceProps'/,
        )
      } finally {
        await fs.writeFile(stackPath, original, 'utf-8')
      }
    },
    TIMEOUT_MS,
  )
})
