/**
 * `package.json`'s `sideEffects` array names every module that does something when merely
 * evaluated. Bundlers drop any other module whose exports go unused, which is what keeps
 * `import { assetUrl } from 'canopycms'` from dragging the root barrel's zod config schemas into a
 * client bundle.
 *
 * A module belongs in the list when evaluating it has an effect that something depends on even if
 * nobody uses its exports: a stylesheet import (`editor/theme.tsx`), a top-level run (the
 * `cli/cli.ts` bin), or test-runner registration (`expect.extend`, a top-level `beforeEach`).
 * List each shipped module twice, as `./src/<path>` for workspace consumers (whose dev `exports`
 * resolve to src) and `./dist/<path>.js` for the published tarball.
 *
 * What is deliberately absent:
 * - `defineEndpoint` pushes into `ROUTE_REGISTRY` at module scope, but only
 *   `scripts/generate-client.ts` reads that registry, unbundled under tsx with explicit imports.
 *   The router mounts routes through `api/routes.ts`'s named imports, never through the registry.
 * - Module-scope loggers, zod schemas and `Symbol.for` keys construct values; dropping an unused
 *   one loses nothing.
 *
 * A module whose effect must happen on import (a registration, a global getter, a polyfill) is
 * added to the list in the same change. A bare `import './x'` of an unlisted module is silently
 * dropped by webpack, so the last test below rejects one.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function declaredSideEffects(): Promise<string[]> {
  const pkg: unknown = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  const value =
    typeof pkg === 'object' && pkg !== null && 'sideEffects' in pkg ? pkg.sideEffects : undefined
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new Error('package.json must declare sideEffects as an array of paths')
  }
  return value
}

describe('root entry tree-shaking', () => {
  let consumerDir: string

  beforeAll(async () => {
    consumerDir = await mkdtemp(path.join(tmpdir(), 'canopy-side-effects-'))
    await mkdir(path.join(consumerDir, 'node_modules'))
    await symlink(packageDir, path.join(consumerDir, 'node_modules', 'canopycms'))
  })

  afterAll(async () => {
    await rm(consumerDir, { recursive: true, force: true })
  })

  it('bundles assetUrl from the package root without zod or the config schemas', async () => {
    const result = await build({
      stdin: {
        contents:
          "import { assetUrl } from 'canopycms'\nconsole.log(assetUrl({ src: '/x.png' }))\n",
        resolveDir: consumerDir,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      metafile: true,
      logLevel: 'silent',
      absWorkingDir: consumerDir,
    })
    const [output] = Object.values(result.metafile.outputs)
    const kept = Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([file]) => path.resolve(consumerDir, file))
    const configDir = path.join(packageDir, 'src', 'config') + path.sep

    expect(kept).toContain(path.join(packageDir, 'src', 'assets', 'asset-url.ts'))
    expect(kept.filter((file) => file.includes(`${path.sep}zod${path.sep}`))).toEqual([])
    expect(kept.filter((file) => file.startsWith(configDir))).toEqual([])
  })
})

describe('sideEffects declaration', () => {
  it('names only files that exist, each shipped one under both src and dist', async () => {
    const declared = await declaredSideEffects()
    expect(declared.length).toBeGreaterThan(0)

    for (const entry of declared) {
      const src = entry.match(/^\.\/src\/(.+)\.tsx?$/)
      const dist = entry.match(/^\.\/dist\/(.+)\.js$/)
      expect(src ?? dist, `${entry} must be ./src/<path>.ts(x) or ./dist/<path>.js`).toBeTruthy()

      if (src) {
        expect(existsSync(path.join(packageDir, entry)), `${entry} does not exist`).toBe(true)
        // test-utils never ships: tsconfig.build.json excludes it.
        if (!entry.startsWith('./src/test-utils/')) {
          expect(declared, `${entry} ships, so its dist twin must be listed`).toContain(
            `./dist/${src[1]}.js`,
          )
        }
      } else if (dist) {
        const twins = [`./src/${dist[1]}.ts`, `./src/${dist[1]}.tsx`]
        const twin = twins.find((candidate) => declared.includes(candidate))
        expect(twin, `${entry} must have its src twin listed`).toBeDefined()
      }
    }
  })

  it('has no bare relative import of a module outside the list', async () => {
    const declared = new Set(await declaredSideEffects())
    const srcDir = path.join(packageDir, 'src')
    const files = (await readdir(srcDir, { recursive: true })).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.(test|stories)\.tsx?$/.test(file) &&
        !file.split(path.sep).includes('__integration__'),
    )

    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(path.join(srcDir, file), 'utf8')
      for (const match of source.matchAll(/^import\s+['"](\.[^'"]+)['"]/gm)) {
        const target = path.relative(packageDir, path.resolve(srcDir, path.dirname(file), match[1]))
        const listed = ['.ts', '.tsx'].some((ext) =>
          declared.has(`./${target.split(path.sep).join('/')}${ext}`),
        )
        if (!listed) offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
