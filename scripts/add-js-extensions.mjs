#!/usr/bin/env node
// Rewrites extensionless relative imports in a built ESM dist directory to
// include explicit .js extensions (or expand directory specifiers to
// /index.js). tsc with moduleResolution:"Bundler" preserves bare relative
// specifiers verbatim (e.g. `from './adapter'`), which Node's native ESM
// resolver rejects with ERR_MODULE_NOT_FOUND.
//
// This applies to BOTH the emitted .js and the emitted .d.ts. The .d.ts half is
// easy to overlook because its failure is silent rather than loud: a consumer on
// moduleResolution "node16"/"nodenext" cannot resolve `export * from './x'`
// inside a .d.ts, and TypeScript's recovery is to type the whole import as
// `any` — so the adopter's build stays GREEN while every type this package
// exports quietly degrades to `any`. With skipLibCheck:false they at least see
// TS2834/TS2835 diagnostics pointing into node_modules; with skipLibCheck:true
// (what most scaffolds set, Next.js included) there is no signal at all.
// Verified both ways against a real packed tarball before this was fixed.
//
// Appending `.js` is correct for a .d.ts MODULE SPECIFIER: TypeScript resolves a
// `./x.js` specifier to `./x.d.ts`, which is why declaration files must name the
// RUNTIME extension and never `.d.ts`.
//
// Caveat, pre-existing but wider now that .d.ts is in scope: this is a textual
// rewrite and cannot tell a specifier from prose. An `import`-shaped string in a
// comment or a JSDoc @example gets the same treatment, so a doc example citing
// `../canopycms.config` becomes `../canopycms.config.js`. Harmless — it changes
// no resolution — but it is adopter-visible in IntelliSense, so don't read a
// rewritten example as evidence the file it names exists.
//
// Shared by every published package's build so there is ONE implementation.
// Each package invokes this against its own dist/ after tsc emits it, either
// via the CLI form below (`node <path-to-this-file>/add-js-extensions.mjs
// dist`, path resolved relative to the invoking package's cwd) or by
// importing `addJsExtensions` directly.
//
// packages/canopycms has extra postbuild steps that are specific to it (CLI
// template-file copying, tsx-shebang stripping, esbuild bundling of CLI
// entrypoints) — those stay in packages/canopycms/scripts/postbuild.mjs,
// which imports `addJsExtensions` from here instead of duplicating it.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// safe-regex (behind security/detect-unsafe-regex) flags this on star height
// alone: `[^'"]*` sits inside the optional `(?:\/...)?` group. A `?` group
// matches at most once, so there is no nested repetition to backtrack through,
// and the two branches it could ambiguate with are disjoint. Measured
// 2026-08-22 at 0.2ms against a 50KB adversarial non-matching input -- linear,
// not exponential. Suppressed at the line rather than disabling the rule for
// the directory, so a genuinely unsafe pattern added later still trips it.
const RELATIVE_IMPORT_RE =
  // eslint-disable-next-line security/detect-unsafe-regex
  /(from\s+['"]|import\s*\(\s*['"]|import\s+['"])(\.\.?(?:\/[^'"]*)?)(['"])/g

export async function addJsExtensions(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    // .d.ts as well as .js — see the header note on silent `any` degradation.
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) continue
    const filePath = join(entry.parentPath ?? entry.path, entry.name)
    const original = await readFile(filePath, 'utf8')

    const rewritten = original.replace(RELATIVE_IMPORT_RE, (match, prefix, specifier, quote) => {
      // Already has a JS/TS file extension — leave it alone
      if (/\.[cm]?[jt]sx?$/.test(specifier)) return match
      // Non-JS assets are not modules we can suffix: `./x.css` must not become
      // `./x.css.js`. None exist in any dist today; this keeps a future one from
      // being silently corrupted rather than merely unrewritten.
      if (/\.(css|scss|sass|less|json|node|wasm|svg|png|jpe?g|gif|webp|woff2?)$/i.test(specifier)) {
        return match
      }

      const base = resolve(dirname(filePath), specifier)

      // If specifier points to a directory, expand it to its index. Named as
      // index.js in .d.ts files too — tsc maps that to index.d.ts.
      //
      // This covers the bare `.` / `..` forms as well: `from '.'` resolves to
      // the containing directory, so it lands here and becomes './index.js'.
      // Node's ESM resolver and TypeScript's node16/nodenext modes both reject
      // a bare '.' — the one occurrence in this repo (operating-mode/types.ts)
      // was invisible until the .d.ts half of this rewrite started running.
      if (existsSync(base) && statSync(base).isDirectory()) {
        const withoutTrailingSlash = specifier.endsWith('/') ? specifier.slice(0, -1) : specifier
        return `${prefix}${withoutTrailingSlash}/index.js${quote}`
      }

      // Otherwise append .js
      return `${prefix}${specifier}.js${quote}`
    })

    if (rewritten !== original) {
      await writeFile(filePath, rewritten)
    }
  }
}

// Self-test for the specifier pattern and the rewrite itself, run as the first
// step of `pnpm check:esm` so it executes in CI.
//
// This exists because the pattern is the single most fragile part of the script
// and its failure modes are silent in both directions: too narrow and a relative
// specifier ships unrewritten (a bare `.` did exactly that for months), too wide
// and a bare package name gets a spurious `.js` welded onto it. Neither shows up
// as a build error.
async function selfTest() {
  const failures = []
  // All three prefix alternatives the pattern supports. `import(...)` matters
  // twice over: it is how tsc writes inline type references in .d.ts, AND how
  // function-body dynamic imports appear in .js — and those are never executed
  // by the runtime probe, so a regression there has no other guard.
  const forms = [
    (spec) => `from '${spec}'`,
    (spec) => `import('${spec}')`,
    (spec) => `import '${spec}'`,
  ]
  const expectMatch = (input, expected) => {
    for (const form of forms) {
      const line = form(input)
      RELATIVE_IMPORT_RE.lastIndex = 0
      const m = RELATIVE_IMPORT_RE.exec(line)
      const actual = m ? m[2] : null
      if (actual !== expected) {
        failures.push(
          `  pattern: ${line} -> ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
        )
      }
    }
  }

  // Relative specifiers the rewrite MUST see.
  for (const spec of ['.', '..', './', '../', './x', '../x/y', './x.js', './a.b.c']) {
    expectMatch(spec, spec)
  }
  // Non-relative specifiers it must NOT touch. A bare package name picking up a
  // `.js` suffix would break every consumer of that dependency.
  for (const spec of ['.foo', '..foo', '...', 'pkg', '@scope/pkg', 'node:fs']) {
    expectMatch(spec, null)
  }

  // End-to-end: a throwaway dist tree covering directory expansion, the bare-dot
  // form, an already-suffixed specifier, and .d.ts alongside .js.
  const tmp = await mkdtemp(join(tmpdir(), 'add-js-ext-selftest-'))
  try {
    await mkdir(join(tmp, 'sub'), { recursive: true })
    await writeFile(join(tmp, 'sub', 'index.js'), 'export const x = 1\n')
    await writeFile(join(tmp, 'sub', 'index.d.ts'), 'export declare const x: number\n')
    await writeFile(join(tmp, 'leaf.js'), 'export const y = 2\n')
    await writeFile(join(tmp, 'theme.css'), '.x { color: red }\n')
    await writeFile(join(tmp, 'leaf.d.ts'), 'export declare const y: number\n')
    await writeFile(
      join(tmp, 'entry.js'),
      [
        "export * from './leaf'",
        "export * from './sub'",
        "export * from './leaf.js'",
        "export const lazy = () => import('./leaf')",
        "import './theme.css'",
      ].join('\n') + '\n',
    )
    await writeFile(
      join(tmp, 'sub', 'self.d.ts'),
      ["import type { x } from '.'", 'export type Z = typeof x'].join('\n') + '\n',
    )

    await addJsExtensions(tmp)

    const entry = await readFile(join(tmp, 'entry.js'), 'utf8')
    const self = await readFile(join(tmp, 'sub', 'self.d.ts'), 'utf8')
    const expectContains = (label, haystack, needle) => {
      if (!haystack.includes(needle)) failures.push(`  ${label}: expected to contain ${needle}`)
    }
    expectContains('file specifier', entry, "'./leaf.js'")
    expectContains('directory specifier', entry, "'./sub/index.js'")
    expectContains('dynamic import', entry, "import('./leaf.js')")
    expectContains('asset specifier left alone', entry, "'./theme.css'")
    expectContains('bare-dot in .d.ts', self, "'./index.js'")
    if (entry.includes('.js.js')) failures.push('  double-suffixed an already-explicit specifier')
    if (entry.includes('.css.js')) failures.push('  suffixed a non-JS asset specifier')

    // Idempotence: running twice must be a no-op, since builds re-run it.
    await addJsExtensions(tmp)
    if ((await readFile(join(tmp, 'entry.js'), 'utf8')) !== entry) {
      failures.push('  not idempotent: a second pass changed the output')
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error('add-js-extensions self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log('add-js-extensions self-test passed.')
}

// Allow direct invocation as a build step:
//   node <this-file> <dist-dir>
//   node <this-file> --self-test
// <dist-dir> is resolved relative to the current working directory, i.e. the
// package running its own build script.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  const target = process.argv[2]
  if (target === '--self-test') {
    await selfTest()
  } else if (!target) {
    console.error('Usage: node add-js-extensions.mjs <dist-dir> | --self-test')
    process.exit(1)
  } else {
    await addJsExtensions(resolve(process.cwd(), target))
  }
}
