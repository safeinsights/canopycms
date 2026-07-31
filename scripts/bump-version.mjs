#!/usr/bin/env node

/**
 * Sets the version across all publishable packages in lockstep.
 *
 * Usage: node scripts/bump-version.mjs            # patch-bump the current version
 *        node scripts/bump-version.mjs <version>  # apply an explicit version
 *
 * The explicit form is used by the prerelease publish path, which computes its
 * version from main rather than from the branch being published, and never
 * commits the result. Only the stable publish workflow commits version fields.
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

const explicitVersion = process.argv[2]
let newVersion
if (explicitVersion) {
  newVersion = explicitVersion
} else {
  const [major, minor, patch] = corePkg.version.split('.').map(Number)
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
