import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  findInstalledPackage,
  hasNextConfig,
  installedNextMajor,
  resolveTracingRoot,
  sharpTracingIncludes,
} from './sharp-tracing'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** The subset of package.json shape these fixtures need to write. */
interface PackageManifest {
  name?: string
  version?: string
  exports?: unknown
  optionalDependencies?: Record<string, string>
}

/** Write `obj` as JSON to `file`, creating parent directories as needed. */
function writeJson(file: string, obj: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(obj, null, 2))
}

/** Write a plain (possibly empty) text file, creating parent directories as needed. */
function writeText(file: string, contents = ''): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/**
 * Create a real directory symlink at `at`, pointing at the real directory `target`. The link
 * itself is written as a RELATIVE path (computed from `at`'s parent directory), matching how
 * pnpm's own store symlinks are written — never as an absolute path.
 */
function link(target: string, at: string): void {
  mkdirSync(path.dirname(at), { recursive: true })
  symlinkSync(path.relative(path.dirname(at), target), at, 'dir')
}

/** Write a package.json for the package directory `dir`. */
function pkg(dir: string, manifest: PackageManifest): void {
  writeJson(path.join(dir, 'package.json'), manifest)
}

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'canopy-sharp-tracing-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// sharpTracingIncludes
// ---------------------------------------------------------------------------

/**
 * Builds a pnpm-style install of canopycms -> sharp 0.35 -> the linux-arm64 native binding and
 * its libvips dependency, all under `root/node_modules`, mirroring pnpm's real virtual store
 * layout (`.pnpm/<pkg>@<version>/node_modules/<dep>` siblings, one level per installed package).
 *
 * `includeSharpLibvipsSibling` controls whether sharp's OWN `@img/sharp-libvips-linux-arm64`
 * sibling symlink is created. Omitting it (case 2) proves libvips is still found solely through
 * the native binding's own sibling symlink — the path sharp's dlopen rpath actually uses.
 *
 * Darwin packages are listed in sharp's optionalDependencies (real sharp lists every platform)
 * but never installed, matching a real single-platform CI/build machine.
 */
function setupPnpmSharpInstall(
  root: string,
  { includeSharpLibvipsSibling = true }: { includeSharpLibvipsSibling?: boolean } = {},
): void {
  const nm = path.join(root, 'node_modules')
  const canopycmsReal = path.join(nm, '.pnpm/canopycms@1.0.0/node_modules/canopycms')
  const sharpReal = path.join(nm, '.pnpm/sharp@0.35.3/node_modules/sharp')
  const bindingReal = path.join(
    nm,
    '.pnpm/@img+sharp-linux-arm64@0.35.3/node_modules/@img/sharp-linux-arm64',
  )
  const libvipsReal = path.join(
    nm,
    '.pnpm/@img+sharp-libvips-linux-arm64@1.3.2/node_modules/@img/sharp-libvips-linux-arm64',
  )

  link(canopycmsReal, path.join(nm, 'canopycms'))
  pkg(canopycmsReal, {
    name: 'canopycms',
    version: '1.0.0',
    // No `require` condition: this is the published shape `require.resolve` throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED on. The test proves findInstalledPackage still finds it.
    exports: { '.': { import: './dist/index.js' } },
  })

  link(sharpReal, path.join(nm, '.pnpm/canopycms@1.0.0/node_modules/sharp'))
  pkg(sharpReal, {
    name: 'sharp',
    version: '0.35.3',
    exports: { '.': './dist/index.js' }, // sharp exports no `./package.json` at all
    optionalDependencies: {
      '@img/sharp-linux-arm64': '0.35.3',
      '@img/sharp-libvips-linux-arm64': '1.3.2',
      '@img/sharp-darwin-arm64': '0.35.3',
      '@img/sharp-libvips-darwin-arm64': '1.3.2',
    },
  })

  // sharp's own @img siblings, within `.pnpm/sharp@0.35.3/node_modules/@img/`: only the linux
  // binding (and, unless suppressed, linux libvips). Darwin is never installed.
  link(bindingReal, path.join(nm, '.pnpm/sharp@0.35.3/node_modules/@img/sharp-linux-arm64'))
  if (includeSharpLibvipsSibling) {
    link(
      libvipsReal,
      path.join(nm, '.pnpm/sharp@0.35.3/node_modules/@img/sharp-libvips-linux-arm64'),
    )
  }

  pkg(bindingReal, {
    name: '@img/sharp-linux-arm64',
    version: '0.35.3',
    optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
  })
  // The binding's rpath looks for libvips beside itself — this sibling symlink is what makes
  // that dlopen actually succeed at runtime, and is reachable even without the one above.
  link(libvipsReal, path.join(path.dirname(bindingReal), 'sharp-libvips-linux-arm64'))

  pkg(libvipsReal, { name: '@img/sharp-libvips-linux-arm64', version: '1.3.2' })
  writeText(path.join(libvipsReal, 'lib/libvips-cpp.so.8.18.3'))
  writeText(path.join(libvipsReal, 'lib/glib-2.0/include/glibconfig.h'))
}

const EXPECTED_PNPM_LIBVIPS_INCLUDE =
  'node_modules/.pnpm/@img+sharp-libvips-linux-arm64@1.3.2/node_modules/@img/sharp-libvips-linux-arm64/lib/**/*'

describe('sharpTracingIncludes', () => {
  describe('pnpm layout', () => {
    it('finds libvips through both sharp and its native binding, deduped to one include', () => {
      writeText(path.join(tmp, 'pnpm-lock.yaml'))
      writeText(path.join(tmp, 'next.config.mjs'))
      setupPnpmSharpInstall(tmp)

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result).toEqual({ includes: [EXPECTED_PNPM_LIBVIPS_INCLUDE] })
      // '@' and '+' are pnpm store-name characters and must NOT be treated as glob
      // metacharacters — this include contains both and is still emitted. Only the characters
      // exercised in the "glob metacharacters" group below are rejected.
      expect(EXPECTED_PNPM_LIBVIPS_INCLUDE).toMatch(/[@+]/)
    })
  })

  describe('project directory reached through a symlink', () => {
    it('emits the same include as for the real directory', () => {
      // Pins `realpathSync(projectDir)` on every platform. On macOS `os.tmpdir()` is already behind
      // a symlink, but on a Linux CI runner it is not, so without this fixture nothing would.
      const real = path.join(tmp, 'real')
      setupPnpmSharpInstall(real)
      const alias = path.join(tmp, 'alias')
      link(real, alias)

      expect(sharpTracingIncludes({ projectDir: alias })).toEqual({
        includes: [EXPECTED_PNPM_LIBVIPS_INCLUDE],
      })
    })
  })

  describe('binding-sibling only', () => {
    it('still finds libvips when only reachable beside the native binding', () => {
      writeText(path.join(tmp, 'pnpm-lock.yaml'))
      writeText(path.join(tmp, 'next.config.mjs'))
      setupPnpmSharpInstall(tmp, { includeSharpLibvipsSibling: false })

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result).toEqual({ includes: [EXPECTED_PNPM_LIBVIPS_INCLUDE] })
    })
  })

  describe('npm hoisted', () => {
    it('finds libvips as a flat sibling under node_modules', () => {
      writeText(path.join(tmp, 'package-lock.json'))
      const nm = path.join(tmp, 'node_modules')

      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
      pkg(path.join(nm, 'sharp'), {
        name: 'sharp',
        version: '0.35.3',
        optionalDependencies: {
          '@img/sharp-linux-arm64': '0.35.3',
          '@img/sharp-libvips-linux-arm64': '1.3.2',
        },
      })
      pkg(path.join(nm, '@img/sharp-linux-arm64'), {
        name: '@img/sharp-linux-arm64',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
      })
      const libvipsDir = path.join(nm, '@img/sharp-libvips-linux-arm64')
      pkg(libvipsDir, { name: '@img/sharp-libvips-linux-arm64', version: '1.3.2' })
      writeText(path.join(libvipsDir, 'lib/libvips-cpp.so.8.18.3'))

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result).toEqual({
        includes: ['node_modules/@img/sharp-libvips-linux-arm64/lib/**/*'],
      })
    })
  })

  describe("npm nested + project's own sharp", () => {
    it('collects libvips from both the nested sharp and the top-level sharp', () => {
      writeText(path.join(tmp, 'package-lock.json'))
      const nm = path.join(tmp, 'node_modules')

      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })

      // canopycms's own nested sharp 0.35, with its own nested libvips.
      const nestedSharp = path.join(nm, 'canopycms/node_modules/sharp')
      pkg(nestedSharp, {
        name: 'sharp',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
      })
      const nestedLibvips = path.join(nm, 'canopycms/node_modules/@img/sharp-libvips-linux-arm64')
      pkg(nestedLibvips, { name: '@img/sharp-libvips-linux-arm64', version: '1.3.2' })
      writeText(path.join(nestedLibvips, 'lib/libvips-cpp.so.8.18.3'))

      // The project's own separately-installed sharp 0.34, with its own top-level libvips.
      const topSharp = path.join(nm, 'sharp')
      pkg(topSharp, {
        name: 'sharp',
        version: '0.34.4',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.2.4' },
      })
      const topLibvips = path.join(nm, '@img/sharp-libvips-linux-arm64')
      pkg(topLibvips, { name: '@img/sharp-libvips-linux-arm64', version: '1.2.4' })
      writeText(path.join(topLibvips, 'lib/libvips-cpp.so.8.16.1'))

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result.problem).toBeUndefined()
      expect(result.includes).toHaveLength(2)
      expect(result.includes).toEqual(
        expect.arrayContaining([
          'node_modules/canopycms/node_modules/@img/sharp-libvips-linux-arm64/lib/**/*',
          'node_modules/@img/sharp-libvips-linux-arm64/lib/**/*',
        ]),
      )
    })
  })

  describe('monorepo root inferred', () => {
    /** Sets up `repo/apps/web` resolving canopycms/sharp/libvips from `repo`'s pnpm store. */
    function setupMonorepo(repo: string): { projectDir: string; expectedInclude: string } {
      const projectDir = path.join(repo, 'apps/web')
      writeText(path.join(repo, 'pnpm-lock.yaml'))
      writeText(path.join(projectDir, 'next.config.mjs'))

      const rootNm = path.join(repo, 'node_modules')
      const canopycmsReal = path.join(rootNm, '.pnpm/canopycms@1.0.0/node_modules/canopycms')
      const sharpReal = path.join(rootNm, '.pnpm/sharp@0.35.3/node_modules/sharp')
      const libvipsReal = path.join(
        rootNm,
        '.pnpm/sharp@0.35.3/node_modules/@img/sharp-libvips-linux-arm64',
      )

      link(canopycmsReal, path.join(projectDir, 'node_modules/canopycms'))
      pkg(canopycmsReal, { name: 'canopycms', version: '1.0.0' })

      link(sharpReal, path.join(rootNm, '.pnpm/canopycms@1.0.0/node_modules/sharp'))
      pkg(sharpReal, {
        name: 'sharp',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
      })

      pkg(libvipsReal, { name: '@img/sharp-libvips-linux-arm64', version: '1.3.2' })
      writeText(path.join(libvipsReal, 'lib/libvips-cpp.so.8.18.3'))

      const expectedInclude = `${path
        .relative(projectDir, path.join(libvipsReal, 'lib'))
        .split(path.sep)
        .join('/')}/**/*`

      return { projectDir, expectedInclude }
    }

    it('walks up to the outermost lockfile when none is configured', () => {
      const repo = path.join(tmp, 'repo')
      const { projectDir, expectedInclude } = setupMonorepo(repo)

      // The include must climb out of the app directory into the workspace root's store.
      expect(expectedInclude.startsWith('../../')).toBe(true)

      const result = sharpTracingIncludes({ projectDir })
      expect(result).toEqual({ includes: [expectedInclude] })
    })

    it('still finds the same outermost root when the app dir ALSO has its own lockfile', () => {
      const repo = path.join(tmp, 'repo')
      const { projectDir, expectedInclude } = setupMonorepo(repo)
      writeText(path.join(projectDir, 'pnpm-lock.yaml'))

      const result = sharpTracingIncludes({ projectDir })
      expect(result).toEqual({ includes: [expectedInclude] })
    })
  })

  describe('outside the tracing root', () => {
    it('reports a configured root that is a subdirectory of the project as outside', () => {
      const projectDir = path.join(tmp, 'repo')
      mkdirSync(path.join(projectDir, 'apps/web'), { recursive: true })

      const result = sharpTracingIncludes({ projectDir, outputFileTracingRoot: 'apps/web' })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('outside the tracing root')
    })

    it('reports a project directory outside a configured sibling root', () => {
      const projectDir = path.join(tmp, 'project')
      const otherRoot = path.join(tmp, 'other-root')
      mkdirSync(projectDir, { recursive: true })
      mkdirSync(otherRoot, { recursive: true })

      const result = sharpTracingIncludes({ projectDir, outputFileTracingRoot: otherRoot })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('is outside the tracing root')
    })

    it('reports a libvips directory that resolves outside a narrower configured root', () => {
      // Distinct from the two cases above: here the PROJECT is inside the root (root is pinned
      // to the project directory itself), but the one libvips directory findInstalledPackage
      // locates is reachable only by walking OUTSIDE the project into a hoisted ancestor
      // node_modules -- exercising the second `isOutside` check, on the lib dir rather than on
      // the project directory.
      const projectDir = path.join(tmp, 'inner')
      const nm = path.join(projectDir, 'node_modules')
      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
      pkg(path.join(nm, 'sharp'), {
        name: 'sharp',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
      })
      const outsideLibvips = path.join(tmp, 'node_modules/@img/sharp-libvips-linux-arm64')
      pkg(outsideLibvips, { name: '@img/sharp-libvips-linux-arm64', version: '1.3.2' })
      writeText(path.join(outsideLibvips, 'lib/libvips-cpp.so.8.18.3'))

      const result = sharpTracingIncludes({ projectDir, outputFileTracingRoot: projectDir })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('is outside the tracing root')
    })
  })

  describe('native binding that carries its own library', () => {
    it("takes the binding's own lib/ when it lists no libvips package, as sharp 0.35's Windows bindings do", () => {
      const nm = path.join(tmp, 'node_modules')
      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
      pkg(path.join(nm, 'sharp'), {
        name: 'sharp',
        version: '0.35.3',
        // Real sharp lists every platform. Only the Windows binding is installed here.
        optionalDependencies: {
          '@img/sharp-win32-x64': '0.35.3',
          '@img/sharp-linux-arm64': '0.35.3',
          '@img/sharp-libvips-linux-arm64': '1.3.2',
        },
      })
      const binding = path.join(nm, '@img/sharp-win32-x64')
      pkg(binding, { name: '@img/sharp-win32-x64', version: '0.35.3' })
      writeText(path.join(binding, 'lib/sharp-win32-x64-0.35.3.node'))

      expect(sharpTracingIncludes({ projectDir: tmp })).toEqual({
        includes: ['node_modules/@img/sharp-win32-x64/lib/**/*'],
      })
    })
  })

  // The absence tests here, in `installedNextMajor` and in `findInstalledPackage` also pin that the
  // lookup walks only the fixture's own `node_modules` hierarchy. Under vitest,
  // `require.resolve.paths` also returns this repo's hoisted `node_modules/.pnpm/node_modules`, so a
  // lookup built on it finds the repo's real canopycms, sharp and next from an empty fixture, and
  // these tests fail.
  describe('not installed', () => {
    it('reports canopycms missing when neither canopycms nor a project sharp is installed', () => {
      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('canopycms is not installed')
    })

    it('reports sharp missing when canopycms is installed but has no sharp', () => {
      pkg(path.join(tmp, 'node_modules/canopycms'), { name: 'canopycms', version: '1.0.0' })

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('no sharp is installed for canopycms')
    })

    it('reports libvips missing when the binding lists a libvips package that is not installed', () => {
      const nm = path.join(tmp, 'node_modules')
      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
      pkg(path.join(nm, 'sharp'), {
        name: 'sharp',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-linux-arm64': '0.35.3' },
      })
      // Lists libvips, as every Linux and macOS binding does, so the binding's own lib/ is not a
      // candidate. The libvips package itself was never installed.
      pkg(path.join(nm, '@img/sharp-linux-arm64'), {
        name: '@img/sharp-linux-arm64',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
      })
      writeText(path.join(nm, '@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.3.node'))

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('no libvips package is installed')
    })

    it('reports a missing lib/ directory inside an installed libvips package', () => {
      const nm = path.join(tmp, 'node_modules')
      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
      pkg(path.join(nm, 'sharp'), {
        name: 'sharp',
        version: '0.35.3',
        optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
      })
      // Package present, but no lib/ subdirectory.
      pkg(path.join(nm, '@img/sharp-libvips-linux-arm64'), {
        name: '@img/sharp-libvips-linux-arm64',
        version: '1.3.2',
      })

      const result = sharpTracingIncludes({ projectDir: tmp })
      expect(result.includes).toEqual([])
      expect(result.problem).toContain('does not exist')
    })
  })

  describe('glob metacharacters', () => {
    it.each([',', '{', '}', '*', '?', '[', '(', '!', '\\'])(
      'refuses a libvips path containing %j',
      (char) => {
        const nm = path.join(tmp, 'node_modules')
        pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
        pkg(path.join(nm, 'sharp'), {
          name: 'sharp',
          version: '0.35.3',
          optionalDependencies: { '@img/sharp-libvips-linux-arm64': '1.3.2' },
        })

        // A pnpm-store-style real directory whose own name embeds the metacharacter; sharp's
        // dependency is a symlink into it, exactly like a real pnpm store entry would be.
        const weirdReal = path.join(tmp, 'store', `sharp-libvips-linux-arm64@1.3.2${char}weird`)
        pkg(weirdReal, { name: '@img/sharp-libvips-linux-arm64', version: '1.3.2' })
        writeText(path.join(weirdReal, 'lib/libvips-cpp.so.8.18.3'))
        link(weirdReal, path.join(nm, '@img/sharp-libvips-linux-arm64'))

        const result = sharpTracingIncludes({ projectDir: tmp })
        expect(result.includes).toEqual([])
        expect(result.problem).toContain('glob metacharacter')
      },
    )
  })

  describe('never throws', () => {
    it('turns an invalid package.json into a problem instead of throwing', () => {
      const nm = path.join(tmp, 'node_modules')
      pkg(path.join(nm, 'canopycms'), { name: 'canopycms', version: '1.0.0' })
      mkdirSync(path.join(nm, 'sharp'), { recursive: true })
      writeText(path.join(nm, 'sharp/package.json'), '{ not valid json')

      let result: ReturnType<typeof sharpTracingIncludes> | undefined
      expect(() => {
        result = sharpTracingIncludes({ projectDir: tmp })
      }).not.toThrow()

      expect(result?.includes).toEqual([])
      expect(result?.problem).toEqual(expect.any(String))
      expect(result?.problem).not.toBe('')
    })
  })
})

// ---------------------------------------------------------------------------
// resolveTracingRoot
// ---------------------------------------------------------------------------

describe('resolveTracingRoot', () => {
  it('lets outputFileTracingRoot win over turbopackRoot', () => {
    const result = resolveTracingRoot({
      projectDir: tmp,
      outputFileTracingRoot: 'root-a',
      turbopackRoot: 'root-b',
    })
    expect(result).toBe(path.resolve(tmp, 'root-a'))
  })

  it('uses turbopackRoot alone when outputFileTracingRoot is not set', () => {
    const result = resolveTracingRoot({ projectDir: tmp, turbopackRoot: 'root-b' })
    expect(result).toBe(path.resolve(tmp, 'root-b'))
  })

  it('resolves a relative configured root against projectDir', () => {
    const result = resolveTracingRoot({ projectDir: tmp, outputFileTracingRoot: '../shared-root' })
    expect(result).toBe(path.resolve(tmp, '../shared-root'))
  })

  it('falls back to projectDir when no lockfile is found anywhere', () => {
    // Assumption specific to this machine: no ancestor of the sandboxed TMPDIR carries a
    // lockfile. Verified directly against this environment before relying on it here (ancestors
    // of the sandbox's os.tmpdir() realpath have none). If that ever stops holding on some other
    // machine, assert against the nearest found lockfile's directory instead of `tmp`.
    const result = resolveTracingRoot({ projectDir: tmp })
    expect(result).toBe(tmp)
  })
})

// ---------------------------------------------------------------------------
// hasNextConfig
// ---------------------------------------------------------------------------

describe('hasNextConfig', () => {
  it.each(['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts'])(
    'is true for %s',
    (name) => {
      writeText(path.join(tmp, name))
      expect(hasNextConfig(tmp)).toBe(true)
    },
  )

  it('is false when no next.config file exists', () => {
    expect(hasNextConfig(tmp)).toBe(false)
  })

  it('is false when next.config.js is a directory rather than a file', () => {
    mkdirSync(path.join(tmp, 'next.config.js'))
    expect(hasNextConfig(tmp)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// installedNextMajor
// ---------------------------------------------------------------------------

describe('installedNextMajor', () => {
  it('reads the major version from an installed Next 14 package', () => {
    pkg(path.join(tmp, 'node_modules/next'), { name: 'next', version: '14.2.25' })
    expect(installedNextMajor(tmp)).toBe(14)
  })

  it('reads the major version from an installed Next 16 package', () => {
    pkg(path.join(tmp, 'node_modules/next'), { name: 'next', version: '16.1.7' })
    expect(installedNextMajor(tmp)).toBe(16)
  })

  it('is null when next is not installed', () => {
    expect(installedNextMajor(tmp)).toBeNull()
  })

  it('is null when the version string does not parse as a number', () => {
    pkg(path.join(tmp, 'node_modules/next'), { name: 'next', version: 'latest' })
    expect(installedNextMajor(tmp)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// findInstalledPackage
// ---------------------------------------------------------------------------

describe('findInstalledPackage', () => {
  it('returns the realpath of a symlinked package', () => {
    const real = path.join(tmp, 'store/canopycms@1.0.0')
    pkg(real, { name: 'canopycms', version: '1.0.0' })
    link(real, path.join(tmp, 'node_modules/canopycms'))

    expect(findInstalledPackage(tmp, 'canopycms')).toBe(realpathSync(real))
  })

  it('returns null when the package is not installed', () => {
    expect(findInstalledPackage(tmp, 'canopycms')).toBeNull()
  })

  it('finds a package whose exports map omits "./package.json"', () => {
    const sharpDir = path.join(tmp, 'node_modules/sharp')
    pkg(sharpDir, {
      name: 'sharp',
      version: '0.35.3',
      exports: { '.': './dist/index.js' },
    })

    expect(findInstalledPackage(tmp, 'sharp')).toBe(realpathSync(sharpDir))
  })
})
