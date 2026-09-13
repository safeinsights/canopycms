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
import { existsSync, readFileSync } from 'node:fs'
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
  // Optional, and set here anyway: these two have to travel bin/app.ts ->
  // CmsStackProps -> lib/cms-stack.ts -> CanopyCmsService -> the worker's .env,
  // and a break anywhere along that chain is invisible to a synth that leaves
  // them unset. The stamps are asserted below. Unset behaviour is covered at
  // the construct level in cms-deploy.test.ts, which can afford both cases.
  // Values chosen NOT to be substrings of any env-var name stamped into the
  // same .env: 'CANOPYCMS_GITHUB_TOKEN' is a prefix of
  // CANOPYCMS_GITHUB_TOKEN_SECRET_ARN, so an implementation that wrote a
  // variable's own NAME as its value would have satisfied the assertion below.
  GITHUB_TOKEN_SECRET_JSON_FIELD: 'ghFieldProbe',
  CLERK_SECRET_KEY_SECRET_JSON_FIELD: 'clerkFieldProbe',
  // Cleared, not merely unset: the synth below spreads `process.env`, and a
  // developer with any one of these exported (plausible — they are the
  // variables this feature is configured with) would put the generated app in
  // App mode, where it refuses to synth alongside GITHUB_TOKEN_SECRET_ARN.
  // Measured: one exported GITHUB_APP_INSTALLATION_ID took the whole file down
  // in `beforeAll`, with an error that blamed the scaffold. The App test below
  // clears the token variables for the mirror-image reason.
  GITHUB_APP_ID: '',
  GITHUB_APP_INSTALLATION_ID: '',
  GITHUB_APP_PRIVATE_KEY_SECRET_ARN: '',
  GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD: '',
}

/**
 * The GitHub App credential, for the second synth below.
 *
 * Kept apart from `SYNTH_ENV` rather than folded into it because the two are
 * mutually exclusive by design: `CanopyCmsService` refuses an App alongside
 * `githubTokenSecretArn`, so a single environment carrying both would fail the
 * synth every other test in this file depends on.
 *
 * Values chosen not to be substrings of any env-var NAME stamped into the same
 * `.env`, for the reason spelled out above `GITHUB_TOKEN_SECRET_JSON_FIELD`.
 */
const APP_SYNTH_ENV = {
  GITHUB_APP_ID: '424242',
  GITHUB_APP_INSTALLATION_ID: '515151',
  GITHUB_APP_PRIVATE_KEY_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:111111111111:secret:canopycms/github-app-key-Ij56Kl',
  GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD: 'appKeyFieldProbe',
}

/** Two cold Node boots, one of which imports all of aws-cdk-lib and stages two assets. */
const TIMEOUT_MS = 120_000

let scaffoldDir: string
let appCommand: string
let synthesizedStacks: string[]
let resourceTypes: Set<string>
/** Every resource in every synthesized template, so assertions can look inside them. */
let resources: unknown[]
/**
 * The raw text of every synthesized template, concatenated.
 *
 * The worker's `.env` is written by a user-data heredoc, so its lines are
 * literal substrings of the template rather than structured fields -- searching
 * the text is what makes an assertion on them robust to how CDK chunks the
 * UserData `Fn::Join`. Same reasoning as the branch-probe test below.
 */
let renderedTemplates: string
/**
 * The `platform` of every Docker image asset in the asset manifests the synth wrote. Read in
 * `beforeAll`, not by the test asserting on it, because the GitHub App test re-synths into the
 * same `cdk.out` and relies on every other test reading state captured here.
 */
let imagePlatforms: (string | undefined)[]

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
  renderedTemplates = ''
  for (const file of templateFiles) {
    const raw = await fs.readFile(path.join(outDir, file), 'utf-8')
    renderedTemplates += raw
    const template: unknown = JSON.parse(raw)
    const templateResources = readJsonField(template, 'Resources')
    if (typeof templateResources !== 'object' || templateResources === null) continue
    for (const resource of Object.values(templateResources)) {
      resources.push(resource)
      const type = readJsonField(resource, 'Type')
      if (typeof type === 'string') resourceTypes.add(type)
    }
  }

  // CDK records the image's platform in the asset manifest, not the template.
  imagePlatforms = []
  for (const file of (await fs.readdir(outDir)).filter((f) => f.endsWith('.assets.json'))) {
    const dockerImages = Manifest.loadAssetManifest(path.join(outDir, file)).dockerImages ?? {}
    for (const image of Object.values(dockerImages)) imagePlatforms.push(image.source.platform)
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

    // The image itself must NOT bake the server half in: the image's `next build`
    // stays in dev mode. Build reads come from the working tree in either mode, so
    // nothing there needs prod, and prod would hold the builder to checks it has
    // no reason to meet (see mode-env.ts). Build arg in, runtime variable out --
    // that pairing is the whole mechanism.
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
   * the host rather than the function cannot run on it.
   */
  it('builds the CMS image for the architecture its Lambda runs on (linux/arm64)', () => {
    expect(imagePlatforms).toEqual(['linux/arm64'])

    const imageFunctionArchitectures = resources
      .filter(
        (resource) =>
          readJsonField(resource, 'Type') === 'AWS::Lambda::Function' &&
          readJsonField(readJsonField(resource, 'Properties'), 'PackageType') === 'Image',
      )
      .map((fn) => readJsonField(readJsonField(fn, 'Properties'), 'Architectures'))
    expect(imageFunctionArchitectures).toEqual([['arm64']])
  })

  /**
   * The scaffold half of adopter request #46. Four files carry this wiring --
   * `bin/app.ts`, `lib/cms-stack.ts`'s props, that file's pass-through to
   * `CanopyCmsService`, and the workflow's `env:` block -- and a break in any
   * one of them produces a deployment where the prop is simply inert: the
   * worker keeps warning that a JSON field should be configured, and the
   * adopter keeps configuring one that never arrives.
   *
   * Synthesizing successfully proves nothing here, because these inputs are
   * OPTIONAL: drop the pass-through in `cms-stack.ts` and synth still succeeds.
   * Only the stamp proves the value travelled.
   */
  it('carries the optional JSON-field inputs through bin/app.ts and cms-stack.ts into the worker .env', () => {
    expect(renderedTemplates).toContain(
      `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD=${SYNTH_ENV.GITHUB_TOKEN_SECRET_JSON_FIELD}`,
    )
    expect(renderedTemplates).toContain(
      `CLERK_SECRET_KEY_SECRET_JSON_FIELD=${SYNTH_ENV.CLERK_SECRET_KEY_SECRET_JSON_FIELD}`,
    )
    // The ARNs travel by the same route and are asserted alongside so a
    // template that lost its .env heredoc entirely cannot pass the two above
    // by some accident of substring matching.
    expect(renderedTemplates).toContain(
      `CANOPYCMS_GITHUB_TOKEN_SECRET_ARN=${SYNTH_ENV.GITHUB_TOKEN_SECRET_ARN}`,
    )
  })

  /**
   * The scaffold half of adopter request #45, and the only place the GitHub App
   * chain is exercised end to end: `bin/app.ts` -> `CmsStackProps` ->
   * `lib/cms-stack.ts`'s pass-through -> `CanopyCmsService` -> the worker's
   * `.env`. Every link is optional, so a synth that succeeds proves nothing;
   * only the stamps do.
   *
   * A SECOND synth of the same scaffold, because the App path is defined by the
   * absence of `GITHUB_TOKEN_SECRET_ARN` -- configuring both is refused at
   * synth, so it cannot share `beforeAll`'s environment. It deliberately reuses
   * `cdk.out` (see CDK_OUTDIR's note above, which is a correctness constraint
   * rather than a preference); every assertion in this file other than this one
   * reads state captured in `beforeAll`, so overwriting it here is invisible to
   * them.
   */
  it(
    'carries the GitHub App inputs through bin/app.ts and cms-stack.ts into the worker .env',
    async () => {
      const cdkJson: unknown = JSON.parse(
        await fs.readFile(path.join(scaffoldDir, 'cdk.json'), 'utf-8'),
      )
      await execFileAsync('sh', ['-c', appCommand], {
        cwd: scaffoldDir,
        timeout: TIMEOUT_MS,
        env: {
          ...process.env,
          ...SYNTH_ENV,
          // The App path's defining condition. Empty rather than deleted: that
          // is how an unset GitHub Actions secret actually arrives, and
          // bin/app.ts's `|| undefined` is what has to read it as absent.
          GITHUB_TOKEN_SECRET_ARN: '',
          GITHUB_TOKEN_SECRET_JSON_FIELD: '',
          ...APP_SYNTH_ENV,
          CDK_OUTDIR: 'cdk.out',
          CDK_CONTEXT_JSON: JSON.stringify(readJsonField(cdkJson, 'context') ?? {}),
        },
      })

      const outDir = path.join(scaffoldDir, 'cdk.out')
      const files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.template.json'))
      let templates = ''
      for (const file of files) templates += await fs.readFile(path.join(outDir, file), 'utf-8')

      expect(templates).toContain(`CANOPYCMS_GITHUB_APP_ID=${APP_SYNTH_ENV.GITHUB_APP_ID}`)
      expect(templates).toContain(
        `CANOPYCMS_GITHUB_APP_INSTALLATION_ID=${APP_SYNTH_ENV.GITHUB_APP_INSTALLATION_ID}`,
      )
      expect(templates).toContain(
        `CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN=${APP_SYNTH_ENV.GITHUB_APP_PRIVATE_KEY_SECRET_ARN}`,
      )
      expect(templates).toContain(
        `CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD=${APP_SYNTH_ENV.GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD}`,
      )
      // The grant, not just the .env: a worker told which secret to read with
      // no permission to read it deploys clean and then AccessDenied-loops
      // every 5s forever.
      //
      // What this pins, precisely: that the GENERATED stack grants it by some
      // route. It does NOT pin the construct's prop-to-IAM union, and measuring
      // that was worth doing -- removing the App ARN from that union leaves
      // this green, because `cms-stack.ts` also lists the key in `secretsArns`.
      // The union is pinned at the construct level in cms-deploy.test.ts, where
      // no `secretsArns` masks it. Both matter: an adopter who hand-writes the
      // stack has only the union.
      //
      // Parsed, NOT a substring search of the template text: the .env stamp
      // asserted above contains that same ARN, so `templates.toContain(arn)`
      // would pass with no IAM statement at all -- coverage that is not there.
      const grantedSecretArns = files.flatMap((file) => {
        const doc: unknown = JSON.parse(readFileSync(path.join(outDir, file), 'utf-8'))
        const policies = Object.values(readJsonField(doc, 'Resources') ?? {}).filter(
          (r) => readJsonField(r, 'Type') === 'AWS::IAM::Policy',
        )
        return policies.flatMap((policy) => {
          const statements = readJsonField(
            readJsonField(readJsonField(policy, 'Properties'), 'PolicyDocument'),
            'Statement',
          )
          return (Array.isArray(statements) ? statements : []).flatMap((s: unknown) => {
            if (!JSON.stringify(readJsonField(s, 'Action')).includes('GetSecretValue')) return []
            const resource = readJsonField(s, 'Resource')
            return (Array.isArray(resource) ? resource : [resource]).filter(
              (r): r is string => typeof r === 'string',
            )
          })
        })
      })
      expect(grantedSecretArns).toContain(APP_SYNTH_ENV.GITHUB_APP_PRIVATE_KEY_SECRET_ARN)
      // ...and the token path is genuinely gone, rather than both being stamped.
      expect(templates).not.toContain('CANOPYCMS_GITHUB_TOKEN_SECRET_ARN=')
    },
    TIMEOUT_MS,
  )

  it('passes the App variables through the generated workflow, CANOPY_-prefixed', async () => {
    // GitHub refuses to create an Actions secret OR variable named GITHUB_*, so
    // the stored names must carry the prefix and the workflow must map them
    // back. A variable missing from this block is not a synth error -- it is a
    // prop no adopter deploying through CI can ever set.
    const workflow = await fs.readFile(
      path.join(scaffoldDir, '.github/workflows/deploy-cms.yml'),
      'utf-8',
    )
    expect(workflow).toContain('GITHUB_APP_ID: ${{ vars.CANOPY_GITHUB_APP_ID }}')
    expect(workflow).toContain(
      'GITHUB_APP_INSTALLATION_ID: ${{ vars.CANOPY_GITHUB_APP_INSTALLATION_ID }}',
    )
    expect(workflow).toContain(
      'GITHUB_APP_PRIVATE_KEY_SECRET_ARN: ${{ secrets.CANOPY_GITHUB_APP_PRIVATE_KEY_SECRET_ARN }}',
    )
  })

  it('passes the JSON-field variables through the generated workflow, which is the only way CI can set them', async () => {
    // bin/app.ts reads these with `|| undefined` rather than `required()`, so a
    // variable missing from the workflow's env: block is not a synth error --
    // it is a prop no adopter deploying through CI can ever set. The workflow
    // file says as much next to the block; this is the check behind that note.
    const workflow = await fs.readFile(
      path.join(scaffoldDir, '.github/workflows/deploy-cms.yml'),
      'utf-8',
    )
    expect(workflow).toContain(
      'GITHUB_TOKEN_SECRET_JSON_FIELD: ${{ vars.CANOPY_GITHUB_TOKEN_SECRET_JSON_FIELD }}',
    )
    expect(workflow).toContain(
      'CLERK_SECRET_KEY_SECRET_JSON_FIELD: ${{ vars.CLERK_SECRET_KEY_SECRET_JSON_FIELD }}',
    )
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
 * one. The generated infrastructure/tsconfig.json extends it, inheriting its `paths` alias and
 * turning its `incremental` off.
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
      // Each one, inherited, fails the type-check, and tsx applies none of them to infrastructure/.
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
