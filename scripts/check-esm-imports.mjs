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
import { builtinModules } from 'node:module'

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
const isSkip = (mode) => /^skip:\s*\S/.test(mode)

// Every mode string must be exactly 'test', or start with 'skip:'/'devOnly'
// using the same anchored forms `isSkip`/`isDevOnly` check. Anything else
// (a typo like 'tests' or 'Test', a 'skip' with no reason) is silently treated
// as neither 'test' NOR `devOnly` by the runtime probe and declaration-resolution
// builders below (both filter with `mode !== 'test'` / `isDevOnly(mode)`), which
// downgrades it to skip-with-no-record instead of failing loudly. Reject it here
// instead, before anything gets built.
function validateModeStrings() {
  const problems = []
  for (const { dir, subpaths } of PACKAGES) {
    for (const [subpath, mode] of Object.entries(subpaths)) {
      if (mode === 'test' || isSkip(mode) || isDevOnly(mode)) continue
      problems.push(
        `${dir}: subpath "${subpath}" has mode ${JSON.stringify(mode)}, which is none of ` +
          "'test', 'skip: <reason>', or 'devOnly'/'devOnly: <reason>' — a typo here silently " +
          'drops the subpath from every check below instead of failing loudly',
      )
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `check-esm-imports.mjs's PACKAGES list has invalid mode string(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
  }
}

// PACKAGES above is a hand-maintained list of directories; nothing else in this
// file reads `packages/` itself. A sixth published package that forgets a
// PACKAGES entry (as well as the add-js-extensions build step) would silently
// ship with zero coverage from this guard — the original defect's exact shape,
// one level up. Catch it here: any `packages/*/package.json` that is not
// `private: true` and is not already in PACKAGES is a problem, checked BEFORE
// the coverage loop below so an unknown directory fails loudly rather than
// just being ignored by every subsequent pass.
function checkPackageListIsComplete() {
  const knownDirs = new Set(PACKAGES.map(({ dir }) => dir))
  const problems = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || knownDirs.has(entry.name)) continue
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json')
    if (!existsSync(pkgJsonPath)) continue // not a package directory at all
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    if (pkg.private === true) continue // intentionally unpublished, out of scope
    problems.push(
      `packages/${entry.name} (package "${pkg.name}") is not private and is missing from ` +
        'PACKAGES in scripts/check-esm-imports.mjs — add an entry (subpaths + their ' +
        "'test'/'skip'/'devOnly' modes) so this guard covers its entry points",
    )
  }
  if (problems.length > 0) {
    throw new Error(
      `check-esm-imports.mjs's PACKAGES list is missing published package(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
  }
}

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
  checkPackageListIsComplete()
  validateModeStrings()

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
      if (publishesDevExports) {
        // The one rule that still applies: with no publishConfig.exports, the dev
        // map publishes verbatim, so a `devOnly` subpath IS published — while
        // being skipped by the runtime probe, skipped by the type pass, and
        // (without this) skipped here too. That is a published entry point with
        // zero coverage: the original defect's exact shape.
        if (isDevOnly(mode)) {
          problems.push(
            `${pkg.name}: "${subpath}" is marked devOnly, but the package has no ` +
              'publishConfig.exports, so its dev exports map publishes verbatim and the ' +
              'subpath ships anyway — add a publishConfig.exports map, or stop marking it devOnly',
          )
        }
        continue
      }
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

// ---------------------------------------------------------------------------
// Static undeclared-dependency scan.
//
// The runtime probe and the declaration-resolution pass below both run inside
// buildSandbox()'s sandbox, which symlinks in EVERY already-installed
// dependency from each package's own node_modules AND the workspace root —
// devDependencies included — and separately drops all 5 PACKAGES in as real,
// dist-backed content regardless of whether the package under test actually
// declares a dependency on any of the other 4. That makes the sandbox
// structurally unable to see a bare specifier that resolves ONLY because the
// workspace happens to hoist it somewhere, or because it names one of the
// other 4 published packages (always present, whether declared or not) — e.g.
// canopycms-cdk importing `canopycms/worker/cms-worker` with zero declared
// dependency on `canopycms` at all. That exact gap shipped: `pnpm check:esm`
// reported OK for canopycms-cdk before its package.json declared `canopycms`
// as a peerDependency.
//
// This pass catches that class directly and without a sandbox: it reads each
// package's OWN dist/ output, collects every bare (non-relative, non-builtin)
// import specifier, and asserts the specifier's package name is declared in
// that SAME package's dependencies/peerDependencies/optionalDependencies —
// never devDependencies, since resolving there is exactly the leak this
// exists to catch. Cheap and deterministic: no sandbox, no subprocess, just a
// directory walk and a regex, and it runs before buildSandbox() so a hit fails
// fast.
const BUILTIN_MODULE_NAMES = new Set(builtinModules)

function isBuiltinSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true
  return BUILTIN_MODULE_NAMES.has(specifier)
}

// Scoped packages (`@scope/name`) contribute their first two path segments;
// everything else contributes its first segment. Works the same whether the
// specifier is the bare package root or a deep subpath (`next/server`, ->
// `next`; `@aws-sdk/client-s3/dist-cjs/x` -> `@aws-sdk/client-s3`).
function packageNameFromSpecifier(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const SCANNABLE_FILE_RE = /\.(?:m?js|cjs|d\.ts|d\.mts|d\.cts)$/

function walkFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath))
    } else if (entry.isFile() && SCANNABLE_FILE_RE.test(entry.name)) {
      results.push(fullPath)
    }
  }
  return results
}

// Three matchers for the only places a real import can name a module in
// compiled JS or a .d.ts:
//
//   * `import ... from '...'` / `export ... from '...'`, both anchored to the
//     START of a line (allowing leading whitespace). tsc never wraps these
//     across lines in this codebase's output (verified: no import/export
//     block here ever puts `from '...'` on a line by itself), and the anchor
//     is load-bearing — the unanchored first version of this regex matched
//     the word "from" followed by a quote ANYWHERE, which is common in this
//     codebase's own error-message and JSDoc prose (e.g. a thrown
//     `` `Cannot derive a valid slug from "${name}"` ``) and produced dozens
//     of bogus "undeclared dependency" hits with garbage specifier text.
//   * a bare `import '...'` side-effect import, same line anchor.
//   * `require('...')` / `import('...')` calls, which — unlike the above —
//     are deliberately NOT line-anchored, since a dynamic import is a normal
//     expression that can appear anywhere (`await import('sharp')` inside a
//     function body, `import('./x.js').SomeType` inside a .d.ts type query).
//     Verified this does not reintroduce the prose problem: every
//     require(/import( in this codebase's dist is a genuine call, none of it
//     JSDoc or string prose that happens to contain that exact substring.
//
// All three keep the matched string within one line (`[^'"\n]`) rather than
// `[\s\S]`, so a missing closing quote on the same line can never let the
// match run on and swallow an unrelated quote several lines later.
const IMPORT_EXPORT_FROM_RE = /^[ \t]*(?:import|export)\b[^\n]*?\bfrom\s+(['"])([^'"\n]*)\1/gm
const BARE_IMPORT_RE = /^[ \t]*import\s+(['"])([^'"\n]*)\1\s*;?\s*$/gm
const CALL_SPECIFIER_RE = /\b(?:require|import)\s*\(\s*(['"])([^'"\n]*)\1\s*\)/g

function extractBareSpecifiers(fileContent) {
  const specifiers = new Set()
  for (const re of [IMPORT_EXPORT_FROM_RE, BARE_IMPORT_RE, CALL_SPECIFIER_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(fileContent))) {
      const specifier = match[2]
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue // relative/absolute
      specifiers.add(specifier)
    }
  }
  return specifiers
}

function checkDeclaredDependencies() {
  const problems = []
  for (const { dir } of PACKAGES) {
    const pkg = toPublishedPackageJson(loadPackageJson(dir))
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])
    const distDir = path.join(packagesDir, dir, 'dist')
    if (!existsSync(distDir)) {
      throw new Error(`${pkg.name}: dist/ does not exist — run \`pnpm build\` first`)
    }

    const offendingFiles = new Map() // undeclared package name -> Set of relative file paths
    for (const file of walkFiles(distDir)) {
      const content = readFileSync(file, 'utf8')
      for (const specifier of extractBareSpecifiers(content)) {
        if (isBuiltinSpecifier(specifier)) continue
        const specifierPkgName = packageNameFromSpecifier(specifier)
        if (specifierPkgName === pkg.name) continue // self-reference
        if (declared.has(specifierPkgName)) continue
        const rel = path.relative(distDir, file)
        if (!offendingFiles.has(specifierPkgName)) offendingFiles.set(specifierPkgName, new Set())
        offendingFiles.get(specifierPkgName).add(rel)
      }
    }

    for (const [specifierPkgName, files] of offendingFiles) {
      const shown = [...files].slice(0, 3)
      const rest = files.size - shown.length
      const fileList = shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '')
      problems.push(
        `${pkg.name}: dist imports "${specifierPkgName}" (e.g. in ${fileList}) but ` +
          'package.json declares it in neither dependencies, peerDependencies, nor ' +
          `optionalDependencies — a consumer installing only ${pkg.name}'s declared ` +
          'dependencies gets ERR_MODULE_NOT_FOUND',
      )
    }
  }
  if (problems.length > 0) {
    throw new Error(
      'check-esm-imports.mjs found undeclared runtime dependencies (static scan of dist/ ' +
        'bare specifiers against declared dependencies):\n' +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
  }
}

// ---------------------------------------------------------------------------
// Stray test-artifact scan.
//
// A dist/ directory should contain only what the package intends to publish.
// A workspace-internal test helper, mock, or `.stories.tsx` that leaks past a
// tsconfig.build.json `exclude` list still ends up inside the tarball (`files`
// only lists directories, not file patterns) even though `exports` makes it
// unreachable by any consumer — dead weight at best, and at worst (a helper
// that imports a devDependency like `vitest` at module scope) exactly the kind
// of thing `checkDeclaredDependencies` above exists to catch, except here it
// is a build-config gap rather than a missing package.json entry. Cheap to
// assert directly: no compiled output should carry a test/story/mock
// filename pattern, full stop.
const STRAY_TEST_ARTIFACT_RE =
  /(?:^|[\\/])(?:__tests?__|.*\.test|.*\.stories)\.(?:m?js|cjs|d\.ts|d\.mts|d\.cts)$|(?:^|[\\/])__tests?__[\\/]/

function checkNoStrayTestArtifacts() {
  const problems = []
  for (const { dir } of PACKAGES) {
    const pkg = loadPackageJson(dir)
    const distDir = path.join(packagesDir, dir, 'dist')
    if (!existsSync(distDir)) {
      throw new Error(`${pkg.name}: dist/ does not exist — run \`pnpm build\` first`)
    }
    for (const file of walkFiles(distDir)) {
      const rel = path.relative(distDir, file)
      if (STRAY_TEST_ARTIFACT_RE.test(rel)) {
        problems.push(`${pkg.name}: dist/${rel} looks like a test/story artifact`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      'check-esm-imports.mjs found test/story artifacts published in dist/ (should be excluded ' +
        "in the package's tsconfig.build.json):\n" +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
  }
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
  // A diagnostic against the probe's own tsconfig means tsc ran but compiled
  // nothing — e.g. an empty `files` list (TS18002). That exits non-zero WITH
  // output, so the assertion above waves it through, and it matches neither
  // filter below, so the pass would report OK having checked zero declarations.
  // Fatal rather than filterable: it says the probe is broken, not the package.
  const probeConfigErrors = output
    .split('\n')
    .filter((line) => /^tsconfig\.json\([0-9]+,[0-9]+\): error TS[0-9]+:/.test(line.trim()))
  if (probeConfigErrors.length > 0) {
    throw new Error(
      `the type probe's own tsconfig is broken, so nothing was typechecked:\n${probeConfigErrors.join('\n')}`,
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

  // Both read dist/ directly — no sandbox needed — so they run first and fail
  // fast, before paying for buildSandbox() below.
  checkDeclaredDependencies()
  console.log('OK    every dist/ bare specifier is declared in its own package.json.\n')
  checkNoStrayTestArtifacts()
  console.log('OK    no test/story artifacts found in any dist/.\n')

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
