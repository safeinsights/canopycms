/**
 * Detection of adopter-project facts that `init-deploy aws` bakes into the
 * generated deployment artifacts.
 *
 * Everything here is best-effort by design: `init-deploy aws` must never fail
 * because a project has no git remote, no lockfile, or no git binary at all.
 * Each detector falls back to the value the templates used before detection
 * existed, so an npm project in a `main`-default repo gets byte-identical
 * output to what shipped previously.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { filePathExists } from '../utils/fs'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry'

/**
 * The package-manager-specific command and file strings the deployment
 * templates need.
 *
 * These reach two very different places -- a GitHub Actions step and a
 * Dockerfile layer -- so they are kept together: a `Dockerfile.cms` that
 * installs with npm while the workflow installs with pnpm is exactly the
 * half-fix that moves a failure rather than removing it.
 */
export interface PackageManagerCommands {
  /** Lockfile that identifies this manager, for the workflow's `paths:` filter. */
  lockfile: string
  /** Install step for CI (runs after actions/setup-node). */
  ciInstall: string
  /** Dockerfile COPY line bringing the manifest + lockfile into the build. */
  dockerCopy: string
  /** Dockerfile install line. */
  dockerInstall: string
  /** How this manager runs the app's build script. */
  build: string
  /** How this manager adds dev dependencies, for the next-steps note. */
  addDev: string
}

const COMMANDS: Record<PackageManager, PackageManagerCommands> = {
  npm: {
    lockfile: 'package-lock.json',
    ciInstall: 'npm ci',
    dockerCopy: 'COPY package*.json ./',
    dockerInstall: 'RUN npm ci',
    build: 'npm run build',
    addDev: 'npm install --save-dev',
  },
  pnpm: {
    lockfile: 'pnpm-lock.yaml',
    ciInstall: 'corepack enable && pnpm install --frozen-lockfile',
    dockerCopy: 'COPY package.json pnpm-lock.yaml ./',
    dockerInstall: 'RUN corepack enable && pnpm install --frozen-lockfile',
    build: 'pnpm run build',
    addDev: 'pnpm add -D',
  },
  yarn: {
    lockfile: 'yarn.lock',
    ciInstall: 'corepack enable && yarn install --frozen-lockfile',
    dockerCopy: 'COPY package.json yarn.lock ./',
    dockerInstall: 'RUN corepack enable && yarn install --frozen-lockfile',
    build: 'yarn build',
    addDev: 'yarn add -D',
  },
  'yarn-berry': {
    lockfile: 'yarn.lock',
    ciInstall: 'corepack enable && yarn install --immutable',
    dockerCopy: 'COPY package.json yarn.lock .yarnrc.yml ./',
    dockerInstall: 'RUN corepack enable && yarn install --immutable',
    build: 'yarn build',
    addDev: 'yarn add -D',
  },
}

export function commandsFor(manager: PackageManager): PackageManagerCommands {
  return COMMANDS[manager]
}

/**
 * Identify the adopter's package manager.
 *
 * `packageManager` (the corepack field) wins when present -- it is the
 * declared intent. Otherwise the lockfile decides. With neither, we return
 * 'npm', which is what every template hardcoded before this existed.
 *
 * Yarn is split into classic vs Berry because the two need different install
 * flags and a different Docker build context, and `yarn.lock`'s *name* cannot
 * tell them apart -- only its first lines can.
 */
export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  for (const dir of await workspaceSearchPath(projectDir)) {
    const declared = await readDeclaredPackageManager(dir)
    if (declared) return declared

    if (await filePathExists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
    if (await filePathExists(path.join(dir, 'yarn.lock'))) {
      return (await isYarnBerryLockfile(dir)) ? 'yarn-berry' : 'yarn'
    }
  }
  return 'npm'
}

/** Hard stop on the upward walk, so a pathological tree cannot climb forever. */
const MAX_WORKSPACE_DEPTH = 8

/**
 * Directories to consult for package-manager evidence, nearest first.
 *
 * Normally just `projectDir`. The exception is a monorepo: in a pnpm/npm/yarn
 * workspace the lockfile and `packageManager` field live at the repo root,
 * while the Next.js app -- the directory an adopter naturally runs
 * `init-deploy aws` in, because that is where `canopycms init` told them to
 * run -- is `apps/site` and has neither. Looking only at `projectDir` there
 * returns 'npm' for a pnpm repo and writes `npm ci` into both the workflow and
 * Dockerfile.cms: silently wrong, and the exact failure this detection exists
 * to prevent.
 *
 * The walk starts only when `projectDir` has a package.json but no evidence of
 * its own -- the signal of a workspace member -- and stops at the directory
 * holding `.git`. Both bounds matter: without them a project with no lockfile
 * anywhere would keep climbing into unrelated directories and adopt a
 * stranger's package manager.
 */
async function workspaceSearchPath(projectDir: string): Promise<string[]> {
  const start = path.resolve(projectDir)
  const dirs = [start]

  // No manifest here means this is not a workspace member; treat the directory
  // at face value rather than inheriting from above.
  if (!(await filePathExists(path.join(start, 'package.json')))) return dirs

  let dir = start
  for (let depth = 0; depth < MAX_WORKSPACE_DEPTH; depth++) {
    if (await filePathExists(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    dirs.push(dir)
  }
  return dirs
}

async function readDeclaredPackageManager(projectDir: string): Promise<PackageManager | null> {
  const pkg = await readPackageJson(projectDir)
  const declared = pkg?.['packageManager']
  if (typeof declared !== 'string') return null

  if (declared.startsWith('pnpm@')) return 'pnpm'
  if (declared.startsWith('npm@')) return 'npm'
  if (declared.startsWith('yarn@')) {
    // Berry is 2.x and up. `yarn@1.x` is classic; anything else we treat as
    // Berry, then confirm against the lockfile when there is one.
    const major = Number.parseInt(declared.slice('yarn@'.length), 10)
    if (Number.isFinite(major) && major >= 2) return 'yarn-berry'
    if (Number.isFinite(major)) return 'yarn'
    return (await isYarnBerryLockfile(projectDir)) ? 'yarn-berry' : 'yarn'
  }
  return null
}

/** Berry lockfiles carry a `__metadata:` block; classic ones start with a v1 banner. */
async function isYarnBerryLockfile(projectDir: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(projectDir, 'yarn.lock'), 'utf-8')
    return content.includes('__metadata:')
  } catch {
    return false
  }
}

/**
 * The branch the deploy workflow should trigger on.
 *
 * Only `origin/HEAD` counts. The obvious-looking fallback -- "use the branch
 * that's checked out" -- would be worse than the hardcoded `main` it replaces:
 * an adopter scaffolding from a setup branch would get
 * `branches: [add-cms]` baked into the workflow, so the deploy would go quiet
 * the moment that branch merged. That silent-trigger failure is the exact LOW
 * this detection exists to fix, so we do not reintroduce it in a
 * harder-to-predict form.
 */
export async function detectDefaultBranch(projectDir: string): Promise<string> {
  const head = await gitRaw(projectDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (!head) return 'main'

  // "origin/main" -> "main"
  const slash = head.indexOf('/')
  const branch = slash === -1 ? head : head.slice(slash + 1)
  return branch || 'main'
}

export interface GitHubRepo {
  owner: string
  repo: string
}

/**
 * Owner/repo from the `origin` remote, for the generated stack's worker
 * config. Supports both SSH (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo`) forms.
 */
export async function detectGitHubRepo(projectDir: string): Promise<GitHubRepo | null> {
  const url = await gitRaw(projectDir, ['remote', 'get-url', 'origin'])
  if (!url) return null

  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

/**
 * Run a git command, returning trimmed stdout or null.
 *
 * Swallows every failure mode on purpose: not a repository, no such ref, no
 * remote, and git not installed at all all surface here as `null` so the
 * caller can fall back to a placeholder.
 */
async function gitRaw(projectDir: string, args: string[]): Promise<string | null> {
  try {
    const output = await simpleGit({ baseDir: projectDir }).raw(args)
    const trimmed = output.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

type PackageJson = Record<string, unknown>

/** Read the adopter's package.json, or null when absent/unparseable. */
export async function readPackageJson(projectDir: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'package.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : null
  } catch {
    return null
  }
}

/**
 * Dependencies the generated CDK app needs at deploy time.
 *
 * `cdk.json` runs `node --import tsx infrastructure/bin/app.ts`, which imports
 * `canopycms-cdk` / `aws-cdk-lib` / `constructs`; CI resolves `cdk` itself
 * through `npx`, but pinning it is what makes a deploy reproducible.
 * `canopycms` is included too: `canopycms-cdk`'s worker re-export
 * (`canopycms/worker/cms-worker`) is a `peerDependency` of `canopycms-cdk`,
 * not a transitive dependency, so an adopter's manifest can otherwise satisfy
 * every other entry here and still fail with `ERR_MODULE_NOT_FOUND`.
 */
export const CDK_DEPENDENCIES = [
  'canopycms',
  'canopycms-cdk',
  'aws-cdk-lib',
  'constructs',
  'tsx',
  'aws-cdk',
] as const

/**
 * Which of {@link CDK_DEPENDENCIES} are missing from the adopter's manifest.
 *
 * Returns them all when there is no package.json to read: a project with no
 * manifest certainly has none of them installed.
 */
export async function missingCdkDependencies(projectDir: string): Promise<string[]> {
  const pkg = await readPackageJson(projectDir)
  const declared = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = pkg?.[field]
    if (typeof section === 'object' && section !== null) {
      for (const name of Object.keys(section)) declared.add(name)
    }
  }
  return CDK_DEPENDENCIES.filter((name) => !declared.has(name))
}
