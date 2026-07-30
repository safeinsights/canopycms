#!/usr/bin/env node

/**
 * Computes the version for an integration (prerelease) publish:
 *   <base version, patch-bumped>-int.<counter>
 *
 * The base is main's version, so a prerelease always sorts above the last
 * stable release and below the next one. The counter is monotonic
 * (github.run_number), which keeps successive prereleases ordered.
 *
 * Usage: node scripts/prerelease-version.mjs <baseVersion> <counter>
 * Outputs the prerelease version to stdout.
 */

const [baseVersion, counter] = process.argv.slice(2)

if (!baseVersion || !counter) {
  console.error('Usage: node scripts/prerelease-version.mjs <baseVersion> <counter>')
  process.exit(1)
}

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion)
if (!match) {
  console.error(`Base version must be a plain <major>.<minor>.<patch> release, got: ${baseVersion}`)
  process.exit(1)
}

if (!/^\d+$/.test(counter)) {
  console.error(`Counter must be a non-negative integer, got: ${counter}`)
  process.exit(1)
}

const [, major, minor, patch] = match

console.log(`${major}.${minor}.${Number(patch) + 1}-int.${Number(counter)}`)
