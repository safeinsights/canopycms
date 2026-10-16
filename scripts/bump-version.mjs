#!/usr/bin/env node

/**
 * Writes one explicit version into every manifest and the generated version
 * constant: the five publishable packages' package.json, the root package.json,
 * and packages/canopycms/src/version.ts. Callers compute the version; this
 * script never derives one.
 *
 * Usage: node scripts/bump-version.mjs <version>
 *
 * <version> is a semver version: x.y.z with an optional -prerelease and +build.
 * Internal dependency ranges move to ^<version>, except workspace: ranges.
 * No argument, an empty argument, a flag, or an extra argument is an error, and
 * the manifests are left untouched.
 *
 * Outputs the written version to stdout.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `new URL(...).pathname`: the latter leaves percent-encoding
// intact (a checkout under a path with a space resolves to `.../my%20repo/...`
// and every read fails) and yields a leading-slash-prefixed drive path on
// Windows. This script rewrites six manifests and gates every release, so it
// should not be the thing that breaks on a directory name.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const PACKAGES = [
  'packages/canopycms',
  'packages/canopycms-next',
  'packages/canopycms-auth-clerk',
  'packages/canopycms-auth-dev',
  'packages/canopycms-cdk',
]

// Leading zeros are rejected deliberately: npm treats `01.2.3` as invalid
// semver, so accepting it here would only move the failure to `npm publish`.
const CORE_VERSION = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`
// Semver's optional `-prerelease` and `+build`, following the spec's identifier
// rules rather than a loose character class: dot-separated identifiers, none
// empty, and a NUMERIC prerelease identifier may not carry a leading zero.
// (`1.2.3-int.007` and `1.2.3-int..1` are invalid semver, and npm rejects
// them -- the same reason the numeric core above rejects `01.2.3`. A looser
// pattern let those through to be written into six manifests and fail later at
// `npm publish`.) Build metadata has no leading-zero rule.
const PRERELEASE_ID = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`
const BUILD_ID = String.raw`[0-9A-Za-z-]+`
// Not user input: the interpolated pieces are String.raw constants declared
// directly above, so there is no injection surface for the rule to protect.
// eslint-disable-next-line security/detect-non-literal-regexp
const EXPLICIT_VERSION_RE = new RegExp(
  `^${CORE_VERSION}` +
    String.raw`(?:-${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*)?` +
    String.raw`(?:\+${BUILD_ID}(?:\.${BUILD_ID})*)?$`,
)

/**
 * Validate an explicit version and return the CANONICAL (trimmed) string to
 * write. Accepts a semver prerelease/build suffix, because the prerelease
 * channel passes `prerelease-version.mjs`'s `X.Y.Z-int.N` output straight through.
 *
 * Returns the trimmed value, not the caller's original, so the validated
 * string and the written string cannot differ.
 */
function parseExplicitVersion(value, label) {
  const trimmed = String(value).trim()
  if (!EXPLICIT_VERSION_RE.test(trimmed)) {
    throw new Error(
      `${label} must be a semver version (x.y.z, optionally -prerelease), got ${JSON.stringify(value)}`,
    )
  }
  return trimmed
}

const args = process.argv.slice(2)

// Validate before touching any manifest: an unrecognised token must not fall
// through and get written verbatim as the version.
const flag = args.find((arg) => arg.startsWith('-'))
if (flag !== undefined) {
  throw new Error(`Unknown option ${JSON.stringify(flag)}. Usage: bump-version.mjs <version>`)
}
if (args.length === 0) {
  throw new Error('Missing version argument. Usage: bump-version.mjs <version>')
}
if (args.length > 1) {
  throw new Error(
    `Unexpected extra argument ${JSON.stringify(args[1])}. Usage: bump-version.mjs <version>`,
  )
}
if (args[0] === '') {
  throw new Error('Empty version argument. Usage: bump-version.mjs <version>')
}

const newVersion = parseExplicitVersion(args[0], 'the version argument')

for (const pkg of PACKAGES) {
  const pkgPath = join(ROOT, pkg, 'package.json')
  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkgJson.version = newVersion

  // Update internal dependency ranges, but preserve workspace: protocol
  for (const depType of ['peerDependencies', 'devDependencies']) {
    if (!pkgJson[depType]) continue
    for (const dep of Object.keys(pkgJson[depType])) {
      if (PACKAGES.some((p) => p.split('/').pop() === dep)) {
        if (!pkgJson[depType][dep].startsWith('workspace:')) {
          pkgJson[depType][dep] = `^${newVersion}`
        }
      }
    }
  }

  writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n')
}

// The package builds with plain tsc (rootDir: src), so src/ cannot import its own
// package.json; this generated constant is how the running code learns its version.
const versionSourcePath = join(ROOT, 'packages/canopycms/src/version.ts')
writeFileSync(
  versionSourcePath,
  [
    '// Generated by scripts/bump-version.mjs, its only writer. The package builds with plain',
    '// tsc (rootDir: src), so src/ cannot import ../package.json; version.test.ts keeps the two equal.',
    `export const CANOPYCMS_VERSION = '${newVersion}'`,
    '',
  ].join('\n'),
)

const rootPkgPath = join(ROOT, 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
rootPkg.version = newVersion
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')

console.log(newVersion)
