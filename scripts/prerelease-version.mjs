#!/usr/bin/env node

/**
 * Computes the version for an integration (prerelease) publish:
 *   <next version>-int.<counter>
 *
 * The next version is main's version patch-bumped, raised to what the branch's
 * pending changesets would release when that is higher (a `changeset status
 * --output` plan), so an int carrying a minor change is versioned as that minor
 * and every prerelease sorts above main's version. The counter is monotonic (github.run_number), which
 * keeps successive prereleases ordered.
 *
 * Usage: node scripts/prerelease-version.mjs <baseVersion> <counter> [--plan <plan.json>]
 * Outputs the prerelease version to stdout.
 */

import { readFileSync } from 'node:fs'

const [baseVersion, counter, flag, planPath, ...extra] = process.argv.slice(2)

if (
  !baseVersion ||
  !counter ||
  (flag !== undefined && (flag !== '--plan' || !planPath)) ||
  extra.length > 0
) {
  console.error(
    'Usage: node scripts/prerelease-version.mjs <baseVersion> <counter> [--plan <plan.json>]',
  )
  process.exit(1)
}

const PLAIN_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/
const match = PLAIN_VERSION_RE.exec(baseVersion)
if (!match) {
  console.error(`Base version must be a plain <major>.<minor>.<patch> release, got: ${baseVersion}`)
  process.exit(1)
}

if (!/^\d+$/.test(counter)) {
  console.error(`Counter must be a non-negative integer, got: ${counter}`)
  process.exit(1)
}

const [, major, minor, patch] = match
let next = `${major}.${minor}.${Number(patch) + 1}`

if (planPath) {
  // The five packages are one `fixed` group, so canopycms's release stands for all of them.
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  const release = plan.releases?.find((r) => r.name === 'canopycms' && r.type !== 'none')
  if (release) {
    if (!PLAIN_VERSION_RE.test(release.newVersion ?? '')) {
      console.error(
        `The plan's canopycms release must be a plain version, got: ${release.newVersion}`,
      )
      process.exit(1)
    }
    // Floored at main patch-bumped: the plan starts from this branch's own
    // manifests, which on an older line would sort the prerelease below a
    // release already out.
    const planned = release.newVersion.split('.').map(Number)
    const floor = next.split('.').map(Number)
    const i = planned.findIndex((n, k) => n !== floor[k])
    if (i !== -1 && planned[i] > floor[i]) next = release.newVersion
  }
}

console.log(`${next}-int.${Number(counter)}`)
