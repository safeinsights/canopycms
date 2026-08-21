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

/** Parse `x.y.z` into a comparable triple. Throws on anything else. */
function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim())
  if (!match) {
    throw new Error(`${label} must be a plain x.y.z version, got ${JSON.stringify(value)}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** > 0 when a is newer than b. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

const [firstArg, secondArg] = process.argv.slice(2)
let newVersion
if (firstArg === '--min') {
  // Bump from whichever is newer: what the repo committed, or what the
  // registry already has. See the `--min` note in the module comment.
  const committed = parseVersion(corePkg.version, 'the committed version')
  const floor = parseVersion(secondArg, '--min')
  const [major, minor, patch] = compareVersions(floor, committed) > 0 ? floor : committed
  newVersion = `${major}.${minor}.${patch + 1}`
} else if (firstArg) {
  newVersion = firstArg
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
