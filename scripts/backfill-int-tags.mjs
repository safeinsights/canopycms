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
 * Usage: node scripts/backfill-int-tags.mjs           # dry run: print the plan
 *        node scripts/backfill-int-tags.mjs --push    # create the missing tags
 * Needs `gh` (signed in, and allowed to create refs for --push), `npm`, and network access.
 */

import { execFileSync } from 'node:child_process'

const REPO = 'safeinsights/canopycms'
const INT_VERSION_RE = /^\d+\.\d+\.\d+-int\.(\d+)$/
const SHA_RE = /^[0-9a-f]{40}$/

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--push')) {
  console.error('Usage: node scripts/backfill-int-tags.mjs [--push]')
  process.exit(1)
}
const push = args[0] === '--push'

const run = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' })

/** The commit an npm version's SLSA provenance says it was built from. */
async function attestedCommit(version) {
  const res = await fetch(
    `https://registry.npmjs.org/-/npm/v1/attestations/canopycms@${encodeURIComponent(version)}`,
  )
  if (!res.ok) return null
  const body = await res.json()
  const slsa = body.attestations?.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1')
  if (!slsa) return null
  const statement = JSON.parse(
    Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
  )
  const sha = statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit
  return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null
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
  run('gh', [
    'api',
    '-X',
    'POST',
    `repos/${REPO}/git/refs`,
    '-f',
    `ref=refs/tags/v${version}`,
    '-f',
    `sha=${attested}`,
  ])
  console.log(`${version}: tagged ${attested}`)
}
process.exit(failed ? 1 : 0)
