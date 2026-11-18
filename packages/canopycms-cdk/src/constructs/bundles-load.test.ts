/**
 * Every esbuild bundle this package ships starts under plain Node on its own, as it does once
 * deployed: one file in a directory with no `node_modules` anywhere above it. A bundle that still
 * reaches for a file esbuild did not inline (a dependency's UMD entry loading its siblings through
 * a `require` esbuild cannot follow) builds cleanly and passes every synth test, then dies at load
 * on the instance.
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = path.join(__dirname, '../..')
const WORKER_BUNDLE = path.join(PACKAGE_ROOT, 'worker/dist/index.js')
const LAMBDA_DIST = path.join(PACKAGE_ROOT, 'lambda/asset-transform/dist')

/** A `require` (or esbuild's renamed copy of one) of a relative path, left in the output. */
const RELATIVE_REQUIRE = /\b[\w$]*require[\w$]*\(\s*["'`]\.{1,2}\//g

const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopy-bundle-load-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Copies `files` into a fresh directory under `scratch`, which nothing above resolves modules from. */
function isolate(name: string, files: string[]): string {
  const dir = path.join(scratch, name)
  for (let up = dir; ; up = path.dirname(up)) {
    const lookup = path.join(up, 'node_modules')
    if (existsSync(lookup)) throw new Error(`${lookup} would resolve what the bundle lacks`)
    if (up === path.dirname(up)) break
  }
  mkdirSync(dir)
  for (const file of files) copyFileSync(file, path.join(dir, path.basename(file)))
  return dir
}

function runNode(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, args, {
    cwd,
    // No NODE_PATH or NODE_OPTIONS from the test runner: the bundle resolves what it carries.
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('the worker bundle', () => {
  const source = readFileSync(WORKER_BUNDLE, 'utf-8')

  it('requires no relative file at run time', () => {
    expect(source.match(RELATIVE_REQUIRE) ?? []).toEqual([])
  })

  // As user data installs it: the bundle beside a `{"type":"module"}` package.json and nothing
  // else. Each role runs all of the bundle's module-level code, then stops at its first missing
  // setting, before any AWS, socket or git call; that message is what shows the load completed.
  // scripts/smoke/worker-platform.mjs runs the same two on the installed file in AL2023.
  const dir = isolate('worker', [WORKER_BUNDLE])
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')

  it.each([
    ['worker', [], 'CANOPYCMS_WORKSPACE_ROOT is required'],
    ['gateway', ['gateway'], 'The GitHub gateway runs socket-activated'],
  ])('loads as the %s with no node_modules', (_role, args, expected) => {
    const { status, output } = runNode(dir, ['index.js', ...args])
    expect(output).toContain(expected)
    expect(status).toBe(1)
  })
})

describe('the asset-transform Lambda bundle', () => {
  const source = readFileSync(path.join(LAMBDA_DIST, 'handler.js'), 'utf-8')

  it('requires no relative file at run time', () => {
    expect(source.match(RELATIVE_REQUIRE) ?? []).toEqual([])
  })

  it('loads under Node with only its declared externals provided', () => {
    // build.mjs's `external` list: sharp and @img/* come from its platform-targeted install and
    // @aws-sdk/* from the Lambda runtime. They are stubbed here; anything else must be inlined.
    // A new external that build.mjs adds without adding it here fails this test, not production.
    const dir = isolate('lambda', [
      path.join(LAMBDA_DIST, 'handler.js'),
      path.join(LAMBDA_DIST, 'package.json'),
    ])
    writeFileSync(
      path.join(dir, 'provided-externals.cjs'),
      `const Module = require('node:module')
const provided = (id) => id === 'sharp' || id.startsWith('@img/') || id.startsWith('@aws-sdk/')
const stub = new Proxy(function () {}, {
  get: (_target, key) => (key === '__esModule' ? false : stub),
  apply: () => stub,
  construct: () => stub,
})
const load = Module._load
Module._load = function (request, ...rest) {
  return provided(request) ? stub : load.call(this, request, ...rest)
}
`,
    )
    // The two variables the handler reads at load, as the function's environment sets them.
    const { status, output } = runNode(
      dir,
      [
        '--require',
        './provided-externals.cjs',
        '-e',
        "const { handler } = require('./handler.js'); console.log('handler: ' + typeof handler)",
      ],
      { ASSET_BUCKET: 'bundle-load-check', AWS_REGION: 'us-east-1' },
    )
    expect(output).toContain('handler: function')
    expect(status).toBe(0)
  })
})
