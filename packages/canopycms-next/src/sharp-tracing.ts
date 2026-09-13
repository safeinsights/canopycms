/**
 * Finds sharp's libvips shared library so `withCanopy` can add it to Next.js output file tracing.
 *
 * **The gap.** sharp loads libvips with `dlopen`, through its native binding's rpath. Nothing
 * `require`s the library, so a tracer that follows imports never sees it. Next's JS tracer
 * (`next/dist/compiled/@vercel/nft`) covers that with a sharp-specific handler, but the handler only
 * fires on a path ending in `sharp/lib/index.js`, which is sharp 0.34's entry point. sharp 0.35
 * ships `dist/index.{cjs,mjs}` instead.
 *
 * Measured on a Next 16.1.7 Turbopack `output: 'standalone'` build: the route traces list
 * libvips's `package.json` and the binding's rpath symlink, but not `lib/libvips-cpp.so.*`. Every
 * load of sharp in the resulting server then fails with ERR_DLOPEN_FAILED. Whether a webpack build
 * reaches the library some other way has not been verified; if it does, Next dedupes the include.
 *
 * Upstream: https://github.com/vercel/next.js/issues/97973 (open). On sharp's side, see
 * https://github.com/lovell/sharp/issues/4567 and https://github.com/lovell/sharp/issues/4543.
 * Once a Next release traces the library itself, this module and its call in `withCanopy` should go.
 *
 * **Finding the directory.** Packages are located by walking up the `node_modules` hierarchy, the
 * way a bundler resolves a bare specifier, never by globbing one package manager's layout. The walk:
 * - start from the `canopycms` the project resolves;
 * - find that copy's `sharp`, and also any `sharp` the project resolves directly;
 * - find each `@img/sharp-libvips-*` optional dependency, from sharp and from each installed native
 *   binding (the binding's rpath looks for libvips beside the binding, so that is the copy it loads);
 * - take that package's real `lib/` directory.
 *
 * **Real paths, not symlinks.** The includes name real directories. A path through a pnpm symlink
 * would land the files somewhere no rpath looks.
 *
 * **What the include does NOT cover.** Under pnpm, the binding reaches the library only through its
 * sibling symlink `.pnpm/@img+sharp-<platform>@<version>/node_modules/@img/sharp-libvips-<platform>`.
 * Next 16.1.7's Turbopack traces that symlink already, and the standalone copy recreates it. If a
 * Next upgrade stops tracing it, the library is present but unreachable. Only a smoke test that
 * loads sharp inside the built image would notice.
 *
 * **Cost.** Turbopack matches includes in "contains" mode, which walks every directory under
 * `node_modules`, following symlinks, once per build, whatever the glob names.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export interface SharpTracingInput {
  /** The directory `next build` runs for. `withCanopy` passes `process.cwd()`. */
  projectDir: string
  /** The adopter's `outputFileTracingRoot`, as written (relative values resolve like Next's). */
  outputFileTracingRoot?: string
  /** The adopter's `turbopack.root`, as written. */
  turbopackRoot?: string
}

export interface SharpTracingResult {
  /** Project-relative POSIX globs, one per libvips `lib/` directory found. */
  includes: string[]
  /** Why nothing was found. Set exactly when `includes` is empty. */
  problem?: string
}

/**
 * The lockfiles Next's own root inference looks for, in its order
 * (`findRootLockFile` in `next/dist/lib/find-root.js`).
 */
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

/**
 * The config file names Next loads (`CONFIG_FILES` in `next/dist/shared/lib/constants.js`).
 * `.mts` is Next 16's, loaded when Node supports TypeScript.
 */
const NEXT_CONFIG_FILES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts']

/**
 * Characters that make a path mean something else as a glob.
 *
 * - Turbopack's glob parser treats `? * [ ] { } , \` specially. The comma matters because Turbopack
 *   joins a route's includes into one `{a,b}` alternation.
 * - The JS tracer's minimatch also reads `( ) !` as extglob syntax.
 *
 * `@` and `+` stay allowed: pnpm directory names are full of them, and neither tracer gives them a
 * meaning unless `(` follows.
 */
const GLOB_METACHARACTERS = /[*?[\]{}(),!\\]/

const LIBVIPS_PACKAGE = /^@img\/sharp-libvips-/
const NATIVE_BINDING_PACKAGE = /^@img\/sharp-(?!libvips-)/

/**
 * `getErrorMessage` from `canopycms/utils/error`, restated.
 *
 * This module is bundled into `dist/config.*`, which esbuild builds with `--packages=external`. An
 * import of that subpath would stay a runtime import inside the adopter's `next.config`, and in this
 * workspace that subpath resolves to raw TypeScript. ARCHITECTURE.md explains why this entrypoint
 * must be plain JavaScript all the way down ("Why the `./config` export ships pre-built").
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile()
}

function isDirectory(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isDirectory()
}

/** True when `target` is not `root` itself or somewhere beneath it. */
function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

interface Manifest {
  name?: string
  version?: string
  optionalDependencyNames: string[]
}

function readManifest(packageDir: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  const manifest: Manifest = { optionalDependencyNames: [] }
  if (typeof parsed !== 'object' || parsed === null) return manifest
  if ('name' in parsed && typeof parsed.name === 'string') manifest.name = parsed.name
  if ('version' in parsed && typeof parsed.version === 'string') manifest.version = parsed.version
  if (
    'optionalDependencies' in parsed &&
    typeof parsed.optionalDependencies === 'object' &&
    parsed.optionalDependencies !== null
  ) {
    manifest.optionalDependencyNames = Object.keys(parsed.optionalDependencies)
  }
  return manifest
}

/**
 * The `node_modules` directories a bare specifier is looked up in from `fromDir`, nearest first.
 *
 * This is only the hierarchy half of Node's lookup (`Module._nodeModulePaths`), on purpose.
 * `require.resolve.paths` also appends Node's global folders (`~/.node_modules`,
 * `~/.node_libraries`, the install prefix's `lib/node`, and `NODE_PATH`), which bundlers do not
 * search. A test runner can add more: vitest puts its own pnpm store there. A package found that
 * way is not one the build resolves.
 */
function nodeModulesLookupDirs(fromDir: string): string[] {
  const dirs: string[] = []
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') dirs.push(path.join(dir, 'node_modules'))
    if (path.dirname(dir) === dir) return dirs
  }
}

/**
 * The real directory of package `name` as a bundler would find it from `fromDir`, or null.
 *
 * Deliberately not `require.resolve(name)`. That goes through the package's `exports` map, and two
 * of the packages this module needs defeat it:
 * - a `canopycms` published without a `require` condition throws ERR_PACKAGE_PATH_NOT_EXPORTED;
 * - sharp exports no `./package.json` at all.
 */
export function findInstalledPackage(fromDir: string, name: string): string | null {
  for (const lookupDir of nodeModulesLookupDirs(fromDir)) {
    const candidate = path.join(lookupDir, name)
    if (isFile(path.join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  return null
}

/** The major version of the `next` installed for `projectDir`, or null if it cannot be read. */
export function installedNextMajor(projectDir: string): number | null {
  try {
    const nextDir = findInstalledPackage(projectDir, 'next')
    if (!nextDir) return null
    const major = Number.parseInt(readManifest(nextDir).version ?? '', 10)
    return Number.isNaN(major) ? null : major
  } catch {
    return null
  }
}

/** Whether `dir` holds a config file Next would load, i.e. whether it can be Next's project dir. */
export function hasNextConfig(dir: string): boolean {
  return NEXT_CONFIG_FILES.some((name) => isFile(path.join(dir, name)))
}

function findLockFileUpwards(startDir: string): string | null {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    for (const name of LOCKFILES) {
      const candidate = path.join(dir, name)
      if (isFile(candidate)) return candidate
    }
    if (path.dirname(dir) === dir) return null
  }
}

/**
 * The tracing root Next will use (`loadConfig` in `next/dist/server/config.js`).
 *
 * The precedence is `outputFileTracingRoot`, then `turbopack.root`, then the directory of the
 * outermost lockfile. That last one is found by searching upwards again from each found lockfile's
 * parent, mirroring `findRootDirAndLockFiles`. Next resolves a relative configured root against the
 * working directory; `withCanopy` only calls this when that directory is the project dir.
 */
export function resolveTracingRoot(input: SharpTracingInput): string {
  const configured = input.outputFileTracingRoot || input.turbopackRoot
  if (configured) return path.resolve(input.projectDir, configured)

  let lockFile = findLockFileUpwards(input.projectDir)
  if (!lockFile) return input.projectDir
  for (;;) {
    const lockDir = path.dirname(lockFile)
    const parentDir = path.dirname(lockDir)
    if (parentDir === lockDir) break
    const outer = findLockFileUpwards(parentDir)
    if (!outer) break
    lockFile = outer
  }
  return path.dirname(lockFile)
}

/** Every installed libvips package directory reachable from one copy of sharp. */
function libvipsDirsFor(sharpDir: string): string[] {
  const found = new Set<string>()
  const collect = (fromDir: string, dependencyNames: string[]) => {
    for (const name of dependencyNames.filter((n) => LIBVIPS_PACKAGE.test(n))) {
      const dir = findInstalledPackage(fromDir, name)
      if (dir) found.add(dir)
    }
  }

  const sharpDependencies = readManifest(sharpDir).optionalDependencyNames
  collect(sharpDir, sharpDependencies)
  for (const bindingName of sharpDependencies.filter((n) => NATIVE_BINDING_PACKAGE.test(n))) {
    const bindingDir = findInstalledPackage(sharpDir, bindingName)
    if (bindingDir) collect(bindingDir, readManifest(bindingDir).optionalDependencyNames)
  }
  return [...found]
}

/**
 * The `outputFileTracingIncludes` globs that ship sharp's libvips, or why there are none.
 *
 * Never throws. A failure anywhere becomes `problem`, because this runs inside the adopter's
 * `next.config` and must not be the thing that breaks their build.
 */
export function sharpTracingIncludes(input: SharpTracingInput): SharpTracingResult {
  try {
    const projectDir = realpathSync(input.projectDir)
    const root = realpathSync(resolveTracingRoot(input))
    if (isOutside(root, projectDir)) {
      return {
        includes: [],
        problem: `the project directory ${projectDir} is outside the tracing root ${root}`,
      }
    }

    const sharpDirs = new Set<string>()
    const canopycmsDir = findInstalledPackage(projectDir, 'canopycms')
    for (const candidate of [
      canopycmsDir && findInstalledPackage(canopycmsDir, 'sharp'),
      findInstalledPackage(projectDir, 'sharp'),
    ]) {
      if (candidate && readManifest(candidate).name === 'sharp') sharpDirs.add(candidate)
    }
    if (sharpDirs.size === 0) {
      return {
        includes: [],
        problem: canopycmsDir
          ? `no sharp is installed for canopycms at ${canopycmsDir}`
          : `canopycms is not installed where ${projectDir} can find it`,
      }
    }

    const includes = new Set<string>()
    const notes: string[] = []
    for (const sharpDir of sharpDirs) {
      const libvipsDirs = libvipsDirsFor(sharpDir)
      if (libvipsDirs.length === 0) {
        notes.push(`no @img/sharp-libvips-* package is installed for sharp at ${sharpDir}`)
      }
      for (const libvipsDir of libvipsDirs) {
        const libDir = path.join(libvipsDir, 'lib')
        if (!isDirectory(libDir)) {
          notes.push(`${libDir} does not exist`)
          continue
        }
        // Turbopack fails the whole build, not just this include, on a glob that climbs out of
        // the tracing root.
        if (isOutside(root, libDir)) {
          notes.push(`${libDir} is outside the tracing root ${root}`)
          continue
        }
        const relative = path.relative(projectDir, libDir).split(path.sep).join('/')
        if (GLOB_METACHARACTERS.test(relative)) {
          notes.push(`${relative} contains a glob metacharacter`)
          continue
        }
        includes.add(`${relative}/**/*`)
      }
    }

    if (includes.size === 0) return { includes: [], problem: notes.join('; ') }
    return { includes: [...includes] }
  } catch (err: unknown) {
    return { includes: [], problem: messageOf(err) }
  }
}
