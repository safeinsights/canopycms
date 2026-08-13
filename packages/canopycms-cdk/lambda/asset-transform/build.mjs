#!/usr/bin/env node
/**
 * Builds the transform Lambda's deployable code asset WITHOUT Docker.
 *
 * sharp needs a native binary for the Lambda's target platform
 * (linux/arm64). Docker-based bundling (the usual `aws-cdk-lib/aws-lambda-nodejs`
 * approach) is unavailable in this environment, so instead:
 *
 *   1. esbuild bundles handler.ts (+ its canopycms/aws-sdk imports) into a
 *      single CJS file, with `sharp`/`@img/*` (native bindings) and
 *      `@aws-sdk/*` (already present in the nodejs22.x Lambda managed
 *      runtime) left external.
 *   2. `npm install sharp@<range> --os=linux --cpu=arm64 --libc=glibc` runs
 *      directly in the output directory. sharp >=0.33 ships its native
 *      binary as a platform-specific optional dependency
 *      (`@img/sharp-linux-arm64` + `@img/sharp-libvips-linux-arm64`) -
 *      npm's `--os`/`--cpu`/`--libc` overrides select which optional
 *      platform package to fetch, independent of the host OS actually
 *      running the install (verified: this pulls the linux/arm64 binary
 *      cleanly from a macOS dev machine). This is the mechanism that makes
 *      Docker unnecessary here.
 *
 * The `<range>` is read from packages/canopycms's own `dependencies.sharp`,
 * so the Lambda's bundled binary stays in lockstep with the sharp version
 * the transform engine (packages/canopycms/src/assets/transform.ts) is
 * written against - never hardcode a version here.
 *
 * Run via `pnpm --filter canopycms-cdk run build:lambda`. Output lands in
 * `dist/` alongside this script (gitignored); `AssetSupport` points
 * `lambda.Code.fromAsset()` at it (see ../../src/constructs/asset-support.ts).
 *
 * `--skip-native` builds step 1 and SKIPS step 2, producing a directory that
 * is deliberately NOT deployable. It exists for the CDK test suite: those
 * tests synth real constructs, and `lambda.Code.fromAsset()` only requires
 * the asset DIRECTORY to exist - it never executes the handler, so the
 * linux/arm64 sharp binary inside it is irrelevant to every assertion they
 * make. Step 2 is a genuine platform-targeted `npm install` (network, tens of
 * seconds); paying it just to let `synth` hash a directory is what kept the
 * 82-test CDK suite out of CI. Skipping it makes the suite cheap enough to
 * gate every PR, which is the whole point.
 *
 * LOAD-BEARING, do not quietly drop: a successful FULL build writes a
 * `.deployable` marker into `dist/` as its very last act, and `AssetSupport`
 * REFUSES to synth without one. The marker is deliberately positive
 * ("this bundle was verified") rather than negative ("this one is bad"),
 * because a negative marker fails open on every path nobody thought about.
 * Concretely, this build can leave a partial, sharp-less `dist/` behind
 * without ever reaching the `--skip-native` branch: if the `npm install`
 * below throws (registry unreachable, offline, proxy, an npm too old for
 * `--os`/`--cpu`/`--libc`) or the `platformPkgDir` check fails, `main()`'s
 * catch sets a non-zero exit code but does NOT remove the handler.js and
 * package.json already written. A "no `.skip-native` file" test would wave
 * that bundle straight through to a deploy; requiring `.deployable` blocks
 * it, because the marker can only exist if the native install actually
 * verified.
 *
 * `--skip-native` additionally writes a `.skip-native` marker. Nothing
 * consumes it - it is there so a human running `ls` can see at a glance why
 * a bundle is being rejected.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, 'dist')
const canopycmsPkgPath = path.resolve(__dirname, '..', '..', '..', 'canopycms', 'package.json')

function log(message) {
  console.log(`[build:lambda] ${message}`)
}

const skipNative = process.argv.includes('--skip-native')

/**
 * Consumed by `AssetSupport` (src/constructs/asset-support.ts), which refuses
 * to synth a bundle without it. Keep the two names in step.
 */
const DEPLOYABLE_MARKER = '.deployable'
const SKIP_NATIVE_MARKER = '.skip-native'

async function main() {
  const canopycmsPkg = JSON.parse(readFileSync(canopycmsPkgPath, 'utf-8'))
  const sharpRange = canopycmsPkg.dependencies?.sharp
  if (!sharpRange) {
    throw new Error(`Could not find a "sharp" dependency in ${canopycmsPkgPath}`)
  }

  log(`Cleaning ${distDir}`)
  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })

  log('Bundling handler.ts with esbuild (sharp, @img/*, @aws-sdk/* external)')
  await build({
    entryPoints: [path.join(__dirname, 'handler.ts')],
    outfile: path.join(distDir, 'handler.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['sharp', '@img/*', '@aws-sdk/*'],
    logLevel: 'info',
  })

  // A package.json (any content) must exist before `npm install` runs
  // against this directory. `"type"` is intentionally omitted so the
  // bundled handler.js (CJS output above) is interpreted correctly.
  writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify(
      { name: 'canopy-asset-transform-lambda', private: true, version: '0.0.0' },
      null,
      2,
    ) + '\n',
  )

  const handlerBytes = statSync(path.join(distDir, 'handler.js')).size

  if (skipNative) {
    // Marker file, not just a log line: `dist/` is gitignored and long-lived,
    // so whoever finds one later (or a future script) can tell a test-only
    // bundle from a deployable one by looking at the directory itself.
    // Human-facing only - nothing consumes this. The guard keys off the
    // ABSENCE of DEPLOYABLE_MARKER, which is what makes it fail closed.
    writeFileSync(
      path.join(distDir, SKIP_NATIVE_MARKER),
      'Built with --skip-native: sharp is NOT installed here. Test fixtures only - do not deploy.\n',
    )
    log(`Bundle ready (--skip-native, NOT DEPLOYABLE): ${distDir}`)
    log(`  handler.js: ${(handlerBytes / 1024).toFixed(1)} KiB`)
    log('  sharp platform binary: SKIPPED - synth only needs this directory to exist')
    return
  }

  const npmArgs = [
    'install',
    `sharp@${sharpRange}`,
    '--no-save',
    '--no-package-lock',
    '--os=linux',
    '--cpu=arm64',
    '--libc=glibc',
  ]
  log(`Installing sharp@${sharpRange} for linux/arm64 into ${distDir}`)
  execFileSync('npm', npmArgs, { cwd: distDir, stdio: 'inherit' })

  const platformPkgDir = path.join(distDir, 'node_modules', '@img', 'sharp-linux-arm64')
  if (!existsSync(platformPkgDir)) {
    throw new Error(
      `Expected ${platformPkgDir} to exist after npm install - sharp's linux/arm64 binary ` +
        'did not install. Confirm the npm version in use supports --os/--cpu/--libc overrides.',
    )
  }

  // LAST act of a successful full build, and only reachable once the
  // platform-binary check above has passed - that ordering is the whole
  // point. AssetSupport requires this file, so anything that leaves a
  // half-built dist/ behind (a thrown npm install, a failed platform check,
  // some future hand-rolled path) is blocked by default rather than
  // permitted by default. Records what was verified, not just that
  // something was.
  writeFileSync(
    path.join(distDir, DEPLOYABLE_MARKER),
    JSON.stringify({ sharpRange, platformPkgDir, builtBy: 'build:lambda' }, null, 2) + '\n',
  )

  log(`Bundle ready: ${distDir}`)
  log(`  handler.js: ${(handlerBytes / 1024).toFixed(1)} KiB`)
  log(`  sharp platform binary: ${platformPkgDir}`)
  log(`  ${DEPLOYABLE_MARKER}: written (AssetSupport will accept this bundle)`)
}

main().catch((err) => {
  console.error('[build:lambda] failed:', err)
  process.exitCode = 1
})
