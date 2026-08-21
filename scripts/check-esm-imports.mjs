#!/usr/bin/env node
/**
 * Regression guard for the extensionless-relative-import defect (see
 * scripts/add-js-extensions.mjs): actually resolves each published
 * package's entry points under Node's native ESM resolver and fails loudly
 * if any of them cannot be imported.
 *
 * MUST run after `pnpm build` — it imports built dist/ output, not src/.
 *
 * Why a sandbox instead of `import('canopycms')` directly: this repo is a
 * pnpm workspace, so node_modules/canopycms is a symlink to
 * packages/canopycms and resolves through its DEV "exports" field (bare
 * *.ts source, meant for bundlers/tsx), never through "publishConfig.exports"
 * — the field real npm consumers actually get. Testing the published shape
 * means testing what npm/pnpm publish actually produce: merging each
 * package's `publishConfig` over its package.json (exactly what `npm
 * publish`/`pnpm pack` do — verified by diffing a real `pnpm pack` tarball's
 * package.json against this merge) and pointing it at the real built dist/.
 * This script does that merge directly instead of shelling out to `pnpm
 * pack`, because `pnpm pack` runs each package's `prepack` script (a full
 * rebuild for canopycms) — redundant after the CI build step already ran,
 * and slow to run on every guard invocation.
 *
 * The resulting sandbox package needs canopycms's OWN peer/runtime
 * dependencies (next, react, @clerk/nextjs, aws-cdk-lib, constructs, ...) to
 * resolve too, so every already-installed dependency is symlinked in from
 * the real workspace node_modules trees (package-local first, then the
 * workspace root as a fallback), skipping the 5 packages under test — those
 * get the merged, dist-backed copy instead so cross-package imports (e.g.
 * canopycms-next -> canopycms) go through publishConfig as well.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.join(repoRoot, 'packages')

// Every package.json `exports` subpath for the 5 published packages must be
// accounted for below as exactly one of three modes:
//
//   'test'              — actually imported under plain Node ESM.
//   'skip: <reason>'    — published, but cannot be exercised this way. Not a
//                         way to avoid failures: each one documents a specific,
//                         verified reason; see the reasons for what was checked.
//   'devOnly: <reason>' — a workspace-internal subpath that is deliberately NOT
//                         published. Present in the dev `exports` map (so other
//                         workspace packages can import it) but absent from
//                         `publishConfig.exports`.
//
// `devOnly` is ENFORCED, not merely declarative: checkCoverage() asserts such a
// subpath is really missing from publishConfig.exports, and that every other
// subpath is really present in it. That cross-check is what keeps a subpath from
// being advertised to npm consumers while pointing at output the build never
// emits — the exact shape of the ./test-utils defect (see below).
const PACKAGES = [
  {
    dir: 'canopycms',
    subpaths: {
      '.': 'test',
      './client':
        'skip: client-only ("use client" editor UI). Transitively imports ' +
        "@mantine/core/styles.css, which Node's ESM loader rejects outright " +
        '(TypeError: Unknown file extension ".css") — only ever consumed through ' +
        'a bundler (webpack/Next), never plain Node.',
      './server': 'test',
      './auth': 'test',
      './auth/cache': 'test',
      './http': 'test',
      './task-queue': 'test',
      './worker/task-queue': 'test',
      './worker/cms-worker': 'test',
      './ai': 'test',
      './build': 'test',
      './utils/error': 'test',
      './test-utils':
        'devOnly: workspace-internal test helpers (mock factories for ApiContext/' +
        'CanopyServices/BranchContext, a console spy, git repo init), shared with ' +
        'sibling packages via the dev exports map only. Deliberately unpublished: ' +
        'tsconfig.build.json excludes src/test-utils/** from the build, and the ' +
        'sources import vitest at module scope (console-spy.ts even calls ' +
        'expect.extend() as an import side effect and declares a global ' +
        "'declare module vitest' augmentation), so shipping it would put a " +
        'devDependency in the published runtime graph and augment every ' +
        "consumer's vitest types. Was advertised in publishConfig.exports for a " +
        'while without ever being built — ERR_MODULE_NOT_FOUND for anyone who ' +
        'tried it; that entry is now removed.',
    },
  },
  {
    dir: 'canopycms-auth-clerk',
    subpaths: {
      '.': 'test',
      './client':
        'skip: client-only ("use client" hook + Clerk UI components) — imports ' +
        '@clerk/nextjs, which itself pulls in next/navigation client-boundary ' +
        'modules that require a real Next.js app-router runtime, not plain Node.',
      './cache-writer': 'test',
    },
  },
  {
    dir: 'canopycms-auth-dev',
    subpaths: {
      '.': 'test',
      './client':
        'skip: client-only ("use client" hook + UserSwitcherButton/-Modal UI). ' +
        "Treated the same as every other package's client entry even though this " +
        'particular one happens to import cleanly today (its "canopycms/client" ' +
        'import is type-only and erased) — it is still React UI never meant to run ' +
        'outside a bundler, and a future addition to it (e.g. a Mantine CSS import) ' +
        'should not become a surprise failure here.',
      './cache-writer': 'test',
    },
  },
  {
    dir: 'canopycms-cdk',
    subpaths: {
      '.': 'test',
    },
  },
  {
    dir: 'canopycms-next',
    subpaths: {
      '.':
        'skip: requires a running Next.js app, verified directly. adapter.ts ' +
        "imports NextResponse from 'next/server'; Next's own package.json " +
        '"exports" map does not resolve the bare "next/server"/"next/navigation" ' +
        'specifiers under plain Node ESM (confirmed: `node --input-type=module -e ' +
        '"import(\'next/server\')"` fails with ERR_MODULE_NOT_FOUND — "Did you mean ' +
        'to import \\"next/server.js\\"?" — independent of canopycms-next entirely). ' +
        "This is a limitation of the 'next' peer dependency's own exports map, not " +
        'of anything built here; canopycms-next\'s "." entry is only ever consumed ' +
        'from inside a real Next.js app, whose bundler (webpack/Turbopack) resolves ' +
        "these specifiers specially. dist/index.js's OWN relative imports (the thing " +
        'this guard exists to check) are still correctly .js-suffixed — see the ' +
        '"./config" entry below for a same-package entry point that plain Node CAN ' +
        'load, and packages/canopycms-next/dist/index.js by inspection.',
      './client':
        'skip: client-only ("use client"), and hits the same next/navigation ' +
        'resolution limitation as "." above.',
      './config': 'test',
    },
  },
]

function loadPackageJson(dir) {
  return JSON.parse(readFileSync(path.join(packagesDir, dir, 'package.json'), 'utf8'))
}

// Anchored, and requires the delimiter, so a `skip:` reason that happens to open
// with the word cannot silently reclassify a published subpath as unpublished.
// The `test` checks elsewhere are exact comparisons; this matches that rigor.
const isDevOnly = (mode) => /^devOnly(:|$)/.test(mode)

// Fail fast (before spending time building the sandbox) if a package's real
// `exports` map has grown a subpath this file doesn't know about, or if a
// subpath was removed — either way the list above is out of sync.
//
// Also cross-checks the dev `exports` map against `publishConfig.exports`, which
// is where the two can silently disagree: a subpath present in both is published
// and must be covered as `test`/`skip`, while a `devOnly` subpath must appear in
// the dev map and NOT in publishConfig. Without this, publishConfig can advertise
// an entry point whose output the build never emits and nothing in-repo notices,
// because workspace resolution never reads publishConfig at all.
function checkCoverage() {
  const problems = []
  for (const { dir, subpaths } of PACKAGES) {
    const pkg = loadPackageJson(dir)
    const actual = new Set(Object.keys(pkg.exports ?? {}))
    const known = new Set(Object.keys(subpaths))
    // A package with no publishConfig.exports publishes its dev `exports` map
    // verbatim, so the cross-check below does not apply — asserting "missing
    // from publishConfig" there would be exactly backwards. All five packages
    // define one today; this keeps the failure honest if a sixth does not.
    const publishesDevExports = pkg.publishConfig?.exports === undefined
    const published = new Set(Object.keys(pkg.publishConfig?.exports ?? {}))
    for (const subpath of actual) {
      if (!known.has(subpath)) {
        problems.push(`${pkg.name}: exports "${subpath}" is not covered in PACKAGES above`)
      }
    }
    for (const subpath of known) {
      if (!actual.has(subpath)) {
        problems.push(`${pkg.name}: PACKAGES lists "${subpath}", but it is not in exports`)
      }
    }
    for (const [subpath, mode] of Object.entries(subpaths)) {
      if (publishesDevExports) continue
      const devOnly = isDevOnly(mode)
      if (devOnly && published.has(subpath)) {
        problems.push(
          `${pkg.name}: "${subpath}" is marked devOnly in PACKAGES above, but ` +
            'publishConfig.exports still advertises it to npm consumers',
        )
      }
      if (!devOnly && !published.has(subpath)) {
        problems.push(
          `${pkg.name}: "${subpath}" is in exports but missing from ` +
            'publishConfig.exports, so npm consumers never get it — publish it, or ' +
            'mark it devOnly in PACKAGES above',
        )
      }
    }
    for (const subpath of published) {
      if (!actual.has(subpath)) {
        problems.push(
          `${pkg.name}: publishConfig.exports advertises "${subpath}", which is ` +
            'not in the dev exports map',
        )
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `check-esm-imports.mjs's PACKAGES list is out of sync with package.json exports:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
  }
}

// publishConfig fields override their top-level counterparts in the
// published package.json — the same merge `npm publish`/`pnpm pack` perform.
// Verified by diffing a real `pnpm pack` tarball's package.json against this.
function toPublishedPackageJson(pkg) {
  const { publishConfig, ...rest } = pkg
  return { ...rest, ...(publishConfig ?? {}) }
}

// Symlink every entry of `sourceNodeModules` into `sandboxNodeModules`,
// skipping names that already exist there and skipping the 5 packages under
// test (those get real, dist-backed content elsewhere).
function layerInNodeModules(sourceNodeModules, sandboxNodeModules, targetNames) {
  if (!existsSync(sourceNodeModules)) return
  for (const entry of readdirSync(sourceNodeModules)) {
    if (entry === '.bin' || entry === '.pnpm') continue
    if (targetNames.has(entry)) continue

    const destPath = path.join(sandboxNodeModules, entry)
    if (existsSync(destPath)) continue // more-specific layer already provided this

    const srcPath = path.join(sourceNodeModules, entry)
    let stat
    try {
      stat = lstatSync(srcPath)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink() && !stat.isDirectory()) continue
    symlinkSync(srcPath, destPath, 'dir')
  }
}

function buildSandbox() {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'canopycms-esm-check-'))
  const sandboxNodeModules = path.join(sandbox, 'node_modules')
  mkdirSync(sandboxNodeModules, { recursive: true })

  const targetNames = new Set(PACKAGES.map(({ dir }) => loadPackageJson(dir).name))

  // Package-local node_modules first (most accurate for that package's own
  // peer resolution), then the workspace root as a fallback for anything a
  // package-local tree doesn't have.
  for (const { dir } of PACKAGES) {
    layerInNodeModules(path.join(packagesDir, dir, 'node_modules'), sandboxNodeModules, targetNames)
  }
  layerInNodeModules(path.join(repoRoot, 'node_modules'), sandboxNodeModules, targetNames)

  // Now drop in the 5 packages under test as real, dist-backed content with
  // their PUBLISHED package.json (publishConfig merged over the top).
  for (const { dir } of PACKAGES) {
    const pkg = loadPackageJson(dir)
    const distDir = path.join(packagesDir, dir, 'dist')
    if (!existsSync(distDir)) {
      throw new Error(`${pkg.name}: dist/ does not exist — run \`pnpm build\` first`)
    }
    const destDir = path.join(sandboxNodeModules, pkg.name)
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true })
    writeFileSync(
      path.join(destDir, 'package.json'),
      JSON.stringify(toPublishedPackageJson(pkg), null, 2),
    )
    cpSync(distDir, path.join(destDir, 'dist'), { recursive: true })
  }

  return sandbox
}

function buildProbeScript() {
  const imports = []
  for (const { dir, subpaths } of PACKAGES) {
    const pkg = loadPackageJson(dir)
    for (const [subpath, mode] of Object.entries(subpaths)) {
      if (mode !== 'test') continue
      const specifier = subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`
      imports.push({ label: specifier, specifier })
    }
  }

  const body = `
const targets = ${JSON.stringify(imports, null, 2)}
const results = []
for (const { label, specifier } of targets) {
  try {
    await import(specifier)
    results.push({ label, ok: true })
  } catch (err) {
    results.push({ label, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
console.log(JSON.stringify(results))
`
  return { body, count: imports.length }
}

// Second guard, for the OTHER half of the same defect: the emitted .d.ts.
//
// The runtime probe above cannot see this. A .d.ts with an extensionless
// relative import does not throw — TypeScript's recovery under
// moduleResolution "node16"/"nodenext" is to resolve nothing and type the whole
// import as `any`. So the adopter's build stays GREEN while every type this
// package exports silently degrades to `any`; with skipLibCheck:true (what most
// scaffolds set) there is not even a diagnostic. Both states were reproduced
// against a real packed tarball before scripts/add-js-extensions.mjs learned to
// rewrite .d.ts.
//
// Detecting "the type became any" directly is awkward, so this asserts the
// mechanism instead: typecheck a consumer under nodenext with skipLibCheck OFF
// and fail on anything that means "this package's types did not resolve".
//
// Two classes of diagnostic count, and BOTH are needed:
//
//   * Anything attributed to consumer.ts. That file is generated here and
//     imports nothing but our own packages, so every diagnostic in it is ours by
//     construction — a missing .d.ts (TS7016), a broken publishConfig "types"
//     path or exports subpath (TS2307), and so on. Filtering these out by path
//     was the original bug in this guard: `dist/server.d.ts` could be deleted
//     outright and the check still passed green, which is the exact
//     types-silently-vanish failure it exists to catch.
//   * Extension/resolution diagnostics whose path points INTO one of our dist
//     directories. This is the .d.ts-kept-an-extensionless-import case, which
//     surfaces inside our own declarations rather than at the consumer.
//
// Diagnostics attributed to a THIRD-PARTY path are ignored. The probe sets
// `types: []`, so ambient @types are not auto-included and dependency
// declarations emit their own unrelated noise (missing NodeJS namespace, Buffer,
// bare `child_process` specifiers, and Next's own extensionless imports). Note
// the sandbox does have @types/node symlinked in — `types: []` is what excludes
// the globals, not its absence. A handful of our own declarations reference
// `NodeJS.`/`Buffer` under that setting; those produce TS2503/TS2591, which are
// deliberately NOT in the list below because they say nothing about resolution.
const CONSUMER_DIAGNOSTIC_RE = /^consumer\.ts\([0-9]+,[0-9]+\): error TS[0-9]+:/
const DIST_DIAGNOSTIC_RE = /error TS(2834|2835|2307|7016):/

function checkDeclarationResolution(sandbox) {
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    throw new Error(`typescript not found at ${tsc} — run \`pnpm install\` first`)
  }

  const probeDir = path.join(sandbox, 'types-probe')
  mkdirSync(probeDir, { recursive: true })

  // One import per PUBLISHED entry point, type-only: enough to pull each entry's
  // whole .d.ts graph into the program.
  //
  // Deliberately broader than the runtime probe's `test` set. Every `skip` above
  // is a RUNTIME limitation — a CSS import Node's loader rejects, a `next/server`
  // specifier only a bundler resolves — and none of them apply to `import type`,
  // which never executes the module. Restricting this pass to `test` entries
  // left canopycms's entire editor/ declaration subtree unguarded, since only
  // ./client reaches it. `devOnly` subpaths are excluded because they are not
  // published at all.
  const specifiers = []
  for (const { dir, subpaths } of PACKAGES) {
    const pkg = loadPackageJson(dir)
    for (const [subpath, mode] of Object.entries(subpaths)) {
      if (isDevOnly(mode)) continue
      specifiers.push(subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`)
    }
  }

  writeFileSync(
    path.join(probeDir, 'consumer.ts'),
    specifiers
      .map((spec, i) => `import type * as m${i} from '${spec}'\nexport type T${i} = typeof m${i}`)
      .join('\n') + '\n',
  )
  writeFileSync(
    path.join(probeDir, 'package.json'),
    JSON.stringify({ name: 'types-probe', private: true, type: 'module' }, null, 2),
  )
  writeFileSync(
    path.join(probeDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          strict: true,
          noEmit: true,
          // MUST stay false: skipLibCheck:true is precisely what hides this.
          skipLibCheck: false,
          types: [],
          baseUrl: '.',
          paths: {},
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    ),
  )
  // Resolve bare specifiers against the sandbox's node_modules.
  symlinkSync(path.join(sandbox, 'node_modules'), path.join(probeDir, 'node_modules'), 'dir')

  const ourDistPrefixes = PACKAGES.map(
    ({ dir }) => `node_modules/${loadPackageJson(dir).name}/dist/`,
  )
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: probeDir,
    encoding: 'utf8',
  })

  // Prove tsc actually ran. Without this the pass reports "OK" for an empty
  // result, so a broken typescript install or an OOM-killed process would turn
  // the guard into a permanent no-op instead of a failure. A healthy run can
  // legitimately exit either way — 0 with no output, or non-zero carrying
  // third-party noise we filter — so the assertion is on the COMBINATION.
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.signal) {
    throw new Error(`tsc was killed by signal ${result.signal} — type pass did not complete`)
  }
  if (result.status !== 0 && output.trim() === '') {
    throw new Error(
      `tsc exited ${result.status} with no output — type pass did not complete. ` +
        'This is a broken probe, not a clean run.',
    )
  }

  const problems = output
    .split('\n')
    .filter(
      (line) =>
        CONSUMER_DIAGNOSTIC_RE.test(line.trim()) ||
        (DIST_DIAGNOSTIC_RE.test(line) && ourDistPrefixes.some((prefix) => line.includes(prefix))),
    )

  return { specifiers, problems }
}

function main() {
  checkCoverage()

  const sandbox = buildSandbox()
  const { body, count } = buildProbeScript()
  const probePath = path.join(sandbox, 'probe.mjs')
  writeFileSync(probePath, body)

  console.log(`Resolving ${count} entry point(s) under real Node ESM (sandbox: ${sandbox})...\n`)

  const result = spawnSync(process.execPath, [probePath], {
    cwd: sandbox,
    encoding: 'utf8',
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    console.error('Probe process failed to run:')
    console.error(result.stdout)
    console.error(result.stderr)
    process.exit(1)
  }

  const results = JSON.parse(result.stdout.trim())
  let failed = 0
  for (const { label, ok, error } of results) {
    if (ok) {
      console.log(`  OK    ${label}`)
    } else {
      failed++
      console.log(`  FAIL  ${label}`)
      console.log(`        ${error.split('\n')[0]}`)
    }
  }

  console.log()
  if (failed > 0) {
    console.error(
      `check:esm FAILED — ${failed}/${results.length} entry point(s) could not be imported ` +
        'under real Node ESM. If tsc emitted an extensionless relative import ' +
        "(`from './x'` instead of `from './x.js'`), this is it — see " +
        'scripts/add-js-extensions.mjs.',
    )
    // Sandbox left in place on failure for local debugging.
    process.exit(1)
  }

  console.log(`Runtime: all ${results.length} entry point(s) imported cleanly.`)

  const { specifiers, problems } = checkDeclarationResolution(sandbox)
  console.log(
    `\nTypechecking ${specifiers.length} entry point(s)' declarations under ` +
      'moduleResolution:nodenext...\n',
  )
  if (problems.length > 0) {
    for (const line of problems.slice(0, 20)) console.log(`  FAIL  ${line.trim()}`)
    if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`)
    console.error(
      `\ncheck:esm FAILED — ${problems.length} diagnostic(s) show our published types failing ` +
        'to resolve under moduleResolution:nodenext. None of these throw at runtime: ' +
        "TypeScript resolves nothing and types the import as `any`, so an adopter's build stays " +
        'green while our types silently vanish.\n\n' +
        'Two usual causes:\n' +
        "  TS2834/TS2835 in our dist — a .d.ts kept an extensionless relative import (`from './x'`\n" +
        "                              rather than `from './x.js'`). See scripts/add-js-extensions.mjs.\n" +
        '  TS7016/TS2307 at consumer.ts — the declaration file is missing entirely, or a\n' +
        '                              publishConfig "types"/exports path points somewhere that\n' +
        '                              does not exist in the built output.',
    )
    // Sandbox left in place on failure for local debugging.
    process.exit(1)
  }
  console.log(
    `  OK    declarations resolve under nodenext for all ${specifiers.length} entry point(s).`,
  )

  console.log(`\ncheck:esm passed — runtime imports and nodenext type resolution both clean.`)
  rmSync(sandbox, { recursive: true, force: true })
}

main()
