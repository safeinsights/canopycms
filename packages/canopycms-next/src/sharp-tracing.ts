/**
 * Finds sharp's libvips shared library so `withCanopy` can add it to Next.js output file tracing.
 *
 * **The gap.** sharp loads libvips with `dlopen` through its native binding's rpath, so a tracer
 * that follows imports never sees it. Next's JS tracer has a sharp-specific handler, but it only
 * fires on sharp 0.34's entry point `sharp/lib/index.js`; sharp 0.35 ships `dist/index.{cjs,mjs}`
 * instead, so it's missed — on a Next 16.1.7 Turbopack standalone build this leaves
 * `lib/libvips-cpp.so.*` untraced, and the built server fails to load sharp with ERR_DLOPEN_FAILED
 * (`.claude/future-tasks/cms-image-build-epic.md`, "The tracer misses the `.so`"). A webpack build
 * under pnpm fails differently: Next 15.5.21's webpack bundles sharp's JS into a server chunk, so
 * the bundled copy cannot reach its native binding regardless of this include (root cause in
 * `.claude/future-tasks/webpack-standalone-sharp-bundled.md`). An npm install and Next 16's
 * `next build --webpack` have not been checked. Where the JS tracer does trace the library itself,
 * this include merges into one Set rather than duplicating it (upstream: next.js#97973, sharp
 * #4567/#4543 — fixed there, this module goes).
 *
 * **Locating the directory.** Walk up the `node_modules` hierarchy the way a bundler resolves a
 * bare specifier, never glob one package manager's layout: from the `canopycms` the project
 * resolves (and any `sharp` it resolves directly), find each `@img/sharp-libvips-*` dependency of
 * sharp and of each installed native binding — a binding's rpath looks for libvips beside itself,
 * so that sibling copy is the one it loads. A binding with no libvips dependency carries its own
 * native library instead (true of sharp 0.35.3's win32 bindings). Each package's real `lib/`
 * directory becomes one include — never the `.pnpm` symlink beside it, which is the only path a
 * binding's rpath actually resolves in a pnpm layout (checked with `otool`), and which Next
 * 16.1.7's Turbopack already traces (the standalone build recreates it). If a future Next stops
 * tracing that symlink, the library stays present but unreachable — only a smoke test that loads
 * sharp inside the built image would notice.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export interface SharpTracingInput {
  /** The directory `next build` runs for. `withCanopy` passes `process.cwd()`. */
  projectDir: string
  /** The adopter's `outputFileTracingRoot`, as written (relative values resolve like Next's). */
  outputFileTracingRoot?: string
  /** The adopter's `turbopack.root`, as written. */
  turbopackRoot?: string
  /**
   * Which lockfile a root nobody configured comes from.
   * - `'outermost'`, the default: Next 15 and 16 walk up to the outermost lockfile (`findRootDir` in
   *   15.5.21, `findRootDirAndLockFiles` in 16.1.7, both in `next/dist/lib/find-root.js`).
   * - `'closest'`: Next 13 and 14 stop at the nearest one. Their `findRootDir` is a different
   *   function with the same name, called from `assignDefaults` in `server/config.ts` (14.2.25 lines
   *   629-630, 13.5.7 lines 524-525).
   */
  lockfileRoot?: 'outermost' | 'closest'
}

export interface SharpTracingResult {
  /**
   * Project-relative POSIX globs, one per native-library `lib/` directory found. Turbopack matches
   * includes in unanchored "contains" mode and follows symlinked directories rather than confining
   * its walk to the include's own directory, so this costs roughly 5 s of compile time on one
   * measured build.
   */
  includes: string[]
  /** Why nothing was found. Set exactly when `includes` is empty. */
  problem?: string
}

/**
 * The lockfiles Next 15 and later look for when inferring a root, in their order
 * (`findRootLockFile` in `next/dist/lib/find-root.js`).
 */
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

/**
 * The same list in Next 14.2.25 (`lib/find-root.ts`), which predates `bun.lock`. Next 13.5.7's list
 * also lacks `bun.lockb`. So for a Bun project on Next 13, this list can pick a wider root than
 * Next does.
 */
const LEGACY_LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']

/**
 * The config file names Next loads (`CONFIG_FILES` in `next/dist/shared/lib/constants.js`).
 * `.mts` is Next 16's, loaded when Node supports TypeScript.
 */
const NEXT_CONFIG_FILES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts']

/**
 * Characters that make a path mean something else as a glob.
 *
 * - Turbopack's glob parser treats `? * [ { } , \` specially (`turbo-tasks-fs/src/globset.rs:397-403`
 *   at v16.1.7), and `]` is refused along with `[`. The comma matters because Turbopack joins a
 *   route's includes into one `{a,b}` alternation (`crates/next-api/src/nft_json.rs:336`).
 * - Next's JS tracer globs includes with its compiled `glob` (`collect-build-traces.js:424` in
 *   16.1.7), whose minimatch also reads `( ) !` as extglob syntax.
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

/**
 * Any failed stat answers false instead of throwing: a missing path, a race with a delete, or a
 * permission error. `hasNextConfig` calls this outside any `try`, and it runs inside the adopter's
 * `next.config`.
 */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Whether `candidate` is a directory, answering false on any failed stat, as `isFile` does. */
function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
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
 * search. pnpm's bin shims add more: running vitest through `node_modules/.bin`, `NODE_PATH` also
 * holds vitest's store directories and the repo's hoisted `node_modules/.pnpm/node_modules`. A
 * package found that way is not one the build resolves.
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

function findLockFileUpwards(startDir: string, names: readonly string[]): string | null {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isFile(candidate)) return candidate
    }
    if (path.dirname(dir) === dir) return null
  }
}

/**
 * The tracing root Next will use (`loadConfig` in `next/dist/server/config.js`).
 *
 * The precedence is `outputFileTracingRoot`, then `turbopack.root`, then a lockfile's directory:
 * - by default, as in Next 15 and 16: the outermost lockfile, found by searching upwards again from
 *   each found lockfile's parent;
 * - with `lockfileRoot: 'closest'`, as in Next 13 and 14: the nearest one.
 *
 * `SharpTracingInput.lockfileRoot` cites the Next source for each.
 *
 * Next resolves a relative configured root against the working directory; `withCanopy` only calls
 * this when that directory is the project dir.
 */
export function resolveTracingRoot(input: SharpTracingInput): string {
  const configured = input.outputFileTracingRoot || input.turbopackRoot
  if (configured) return path.resolve(input.projectDir, configured)

  if (input.lockfileRoot === 'closest') {
    const closest = findLockFileUpwards(input.projectDir, LEGACY_LOCKFILES)
    return closest ? path.dirname(closest) : input.projectDir
  }

  let lockFile = findLockFileUpwards(input.projectDir, LOCKFILES)
  if (!lockFile) return input.projectDir
  for (;;) {
    const lockDir = path.dirname(lockFile)
    const parentDir = path.dirname(lockDir)
    if (parentDir === lockDir) break
    const outer = findLockFileUpwards(parentDir, LOCKFILES)
    if (!outer) break
    lockFile = outer
  }
  return path.dirname(lockFile)
}

/**
 * Every installed package directory, reachable from one copy of sharp, whose `lib/` holds sharp's
 * native library.
 *
 * That is each `@img/sharp-libvips-*` package, plus any installed native binding that lists no
 * libvips package and so has to carry the library itself.
 */
function nativeLibraryDirsFor(sharpDir: string): string[] {
  const found = new Set<string>()
  const collectLibvips = (fromDir: string, dependencyNames: string[]) => {
    for (const name of dependencyNames.filter((n) => LIBVIPS_PACKAGE.test(n))) {
      const dir = findInstalledPackage(fromDir, name)
      if (dir) found.add(dir)
    }
  }

  const sharpDependencies = readManifest(sharpDir).optionalDependencyNames
  collectLibvips(sharpDir, sharpDependencies)
  for (const bindingName of sharpDependencies.filter((n) => NATIVE_BINDING_PACKAGE.test(n))) {
    const bindingDir = findInstalledPackage(sharpDir, bindingName)
    if (!bindingDir) continue
    const bindingDependencies = readManifest(bindingDir).optionalDependencyNames
    if (bindingDependencies.some((n) => LIBVIPS_PACKAGE.test(n))) {
      collectLibvips(bindingDir, bindingDependencies)
    } else {
      found.add(bindingDir)
    }
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
      const libraryDirs = nativeLibraryDirsFor(sharpDir)
      if (libraryDirs.length === 0) {
        notes.push(
          `no libvips package is installed for sharp at ${sharpDir}, and no installed native binding carries its own library`,
        )
      }
      for (const libraryDir of libraryDirs) {
        const libDir = path.join(libraryDir, 'lib')
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
