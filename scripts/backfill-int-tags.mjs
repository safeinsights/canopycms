#!/usr/bin/env node

/**
 * Tags every published int prerelease of canopycms `v<version>` at the commit
 * it was built from, for the ints published before publish.yml's
 * tag-prerelease job existed. migration-notes.mjs labels changelog entries and
 * finds the previous int through these tags.
 *
 * The commit comes from the version's npm provenance attestation, which
 * records exactly what was built, and must match the head SHA of the
 * publish.yml run whose number is the int's N. A mismatch, or an existing tag
 * at another commit, is reported and that version is skipped.
 *
 * Tags are pushed with git, not created through the REST API, which refuses
 * most older commits with a 404.
 *
 * Usage: node scripts/backfill-int-tags.mjs           # dry run: print the plan
 *        node scripts/backfill-int-tags.mjs --push    # push the missing tags to origin
 * Run from a clone whose `origin` is safeinsights/canopycms. Needs `gh` (signed in), `npm`, git push
 * access for --push, and network access.
 */

import { execFileSync } from 'node:child_process'

import { attestedCommit as npmAttestedCommit } from './npm-attested-commit.mjs'

const REPO = 'safeinsights/canopycms'
const INT_VERSION_RE = /^\d+\.\d+\.\d+-int\.(\d+)$/

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--push')) {
  console.error('Usage: node scripts/backfill-int-tags.mjs [--push]')
  process.exit(1)
}
const push = args[0] === '--push'

const run = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' })

/** The commit a canopycms version's SLSA provenance says it was built from, or null. */
async function attestedCommit(version) {
  try {
    return await npmAttestedCommit('canopycms', version)
  } catch {
    return null
  }
}

/** publish.yml dispatch runs by run number, which is an int's N. */
function runHeads() {
  const out = run('gh', [
    'api',
    '--paginate',
    `repos/${REPO}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=100`,
    '--jq',
    '.workflow_runs[] | "\\(.run_number) \\(.head_sha)"',
  ])
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [n, sha] = line.split(' ')
        return [Number(n), sha]
      }),
  )
}

/** The commit an existing `v<version>` tag points at, or '' when there is none. */
function existingTag(version) {
  return run('gh', [
    'api',
    '--paginate',
    `repos/${REPO}/git/matching-refs/tags/v${version}`,
    '--jq',
    `[.[] | select(.ref == "refs/tags/v${version}") | .object.sha][0] // empty`,
  ]).trim()
}

const versions = JSON.parse(run('npm', ['view', 'canopycms', 'versions', '--json'])).filter((v) =>
  INT_VERSION_RE.test(v),
)
// --push writes to `origin`, while every check above reads safeinsights/canopycms.
if (
  push &&
  !/[/:]safeinsights\/canopycms(\.git)?$/.test(run('git', ['remote', 'get-url', 'origin']).trim())
) {
  console.error(`origin is not ${REPO}; run --push from a clone of it`)
  process.exit(1)
}
const heads = runHeads()
let failed = false
for (const version of versions) {
  const n = Number(INT_VERSION_RE.exec(version)[1])
  const attested = await attestedCommit(version)
  const head = heads.get(n)
  if (!attested || attested !== head) {
    console.error(
      `${version}: attested ${attested ?? 'nothing'}, run ${n} built ${head ?? 'nothing'}; skipped`,
    )
    failed = true
    continue
  }
  const existing = existingTag(version)
  if (existing === attested) {
    console.log(`${version}: v${version} already tags ${attested}`)
    continue
  }
  if (existing) {
    console.error(`${version}: v${version} tags ${existing}, not ${attested}; skipped`)
    failed = true
    continue
  }
  if (!push) {
    console.log(`${version}: would tag ${attested}`)
    continue
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${attested}^{commit}`], { stdio: 'ignore' })
  } catch {
    run('git', ['fetch', '--quiet', 'origin', attested])
  }
  run('git', ['push', '--quiet', 'origin', `${attested}:refs/tags/v${version}`])
  console.log(`${version}: tagged ${attested}`)
}
process.exit(failed ? 1 : 0)
