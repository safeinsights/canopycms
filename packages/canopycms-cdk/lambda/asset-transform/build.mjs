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
 *      `@aws-sdk/*` (already present in the Node 20.x Lambda managed
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

  const handlerBytes = statSync(path.join(distDir, 'handler.js')).size
  log(`Bundle ready: ${distDir}`)
  log(`  handler.js: ${(handlerBytes / 1024).toFixed(1)} KiB`)
  log(`  sharp platform binary: ${platformPkgDir}`)
}

main().catch((err) => {
  console.error('[build:lambda] failed:', err)
  process.exitCode = 1
})
