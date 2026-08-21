#!/usr/bin/env node

/**
 * Sets the version across all publishable packages in lockstep.
 *
 * Usage: node scripts/bump-version.mjs                 # patch-bump the current version
 *        node scripts/bump-version.mjs <version>       # apply an explicit version
 *        node scripts/bump-version.mjs --min <version> # patch-bump max(current, <version>)
 *
 * The explicit form is used by the prerelease publish path, which computes its
 * version from main rather than from the branch being published, and never
 * commits the result. Only the stable publish workflow commits version fields.
 *
 * `--min` exists because the committed version is NOT a reliable record of what
 * has been published. publish.yml commits the version bump only AFTER all five
 * packages publish, so any interruption in between -- a cancelled run, or a
 * non-fast-forward failure of that final push -- leaves npm holding a version
 * main does not know about. Bumping from the committed value then re-derives a
 * version that already exists on the registry, and `npm publish` fails with
 * "cannot publish over previously published version" on EVERY subsequent run:
 * the release train stays wedged until a human intervenes. Passing the
 * registry's current version as `--min` makes that self-healing.
 *
 * Outputs the new version to stdout.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

const PACKAGES = [
  'packages/canopycms',
  'packages/canopycms-next',
  'packages/canopycms-auth-clerk',
  'packages/canopycms-auth-dev',
  'packages/canopycms-cdk',
]

// Read current version from the core package
const corePkgPath = join(ROOT, 'packages/canopycms/package.json')
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'))

// Leading zeros are rejected deliberately: npm treats `01.2.3` as invalid
// semver, so accepting it here would only move the failure to `npm publish`.
const CORE_VERSION = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`
const STRICT_VERSION_RE = new RegExp(`^${CORE_VERSION}$`)
// Semver's optional `-prerelease` and `+build`. The prerelease publish path
// needs this: `prerelease-version.mjs` emits `X.Y.Z-int.N`.
const EXPLICIT_VERSION_RE = new RegExp(
  `^${CORE_VERSION}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`,
)

/**
 * Parse a plain `x.y.z` into a comparable triple. Throws on anything else,
 * INCLUDING a prerelease suffix -- this is used for the committed version and
 * for `--min`, where an `-int.N` value has no meaningful ordering against a
 * stable release and would silently mis-floor the bump.
 */
function parseVersion(value, label) {
  const match = STRICT_VERSION_RE.exec(String(value).trim())
  if (!match) {
    throw new Error(`${label} must be a plain x.y.z version, got ${JSON.stringify(value)}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Validate an explicit version and return the CANONICAL (trimmed) string to
 * write. Accepts a semver prerelease/build suffix, because that is the only
 * shape this mode is ever called with in production: publish-prerelease.yml
 * passes `prerelease-version.mjs`'s `X.Y.Z-int.N` output straight through.
 *
 * Returning the trimmed value rather than the caller's original closes the gap
 * where the string that was VALIDATED and the string that got WRITTEN differed
 * -- ` 1.2.3` used to validate on its trimmed form and then land in six
 * manifests with the leading space intact.
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

/** > 0 when a is newer than b. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

const [firstArg, secondArg] = process.argv.slice(2)

// Reject anything that is not a recognised flag or a plain version BEFORE
// writing to six package.json files. Previously any unrecognised first token
// took the explicit-version branch verbatim: `--mim 0.0.70` wrote
// `"version": "--mim"` across the workspace and exited 0, and the failure only
// surfaced later at `npm publish`. Transposed args (`0.0.64 --min`) silently
// applied the explicit version with no bump.
if (firstArg !== undefined && firstArg !== '--min' && firstArg.startsWith('-')) {
  throw new Error(
    `Unknown option ${JSON.stringify(firstArg)}. Usage: [<version> | --min <version>]`,
  )
}
if (firstArg === '--min' && secondArg === undefined) {
  throw new Error('--min requires a version argument')
}
if (firstArg !== undefined && firstArg !== '--min' && secondArg !== undefined) {
  throw new Error(
    `Unexpected extra argument ${JSON.stringify(secondArg)} after an explicit version. ` +
      `Did you mean: --min ${firstArg}?`,
  )
}

let newVersion
if (firstArg === '--min') {
  // Bump from whichever is newer: what the repo committed, or what the
  // registry already has. See the `--min` note in the module comment.
  const committed = parseVersion(corePkg.version, 'the committed version')
  const floor = parseVersion(secondArg, '--min')
  const [major, minor, patch] = compareVersions(floor, committed) > 0 ? floor : committed
  newVersion = `${major}.${minor}.${patch + 1}`
} else if (firstArg) {
  // Validated AND canonicalised: the returned value is what gets written, so
  // the validated string and the written string cannot differ.
  newVersion = parseExplicitVersion(firstArg, 'the explicit version argument')
} else {
  const [major, minor, patch] = parseVersion(corePkg.version, 'the committed version')
  newVersion = `${major}.${minor}.${patch + 1}`
}

// Update all packages
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

// Also update root package.json version
const rootPkgPath = join(ROOT, 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
rootPkg.version = newVersion
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')

console.log(newVersion)
