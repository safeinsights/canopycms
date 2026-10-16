#!/usr/bin/env node

/**
 * Prints the commit a published package version was built from, read from its
 * npm SLSA provenance attestation, or nothing when that version is not on npm.
 * Any other answer (published without provenance or not yet attested, a
 * malformed attestation, a registry error) exits 1: a caller deciding whether
 * to publish must not read "unknown" as "absent".
 *
 * Usage: node scripts/npm-attested-commit.mjs <package> <version>
 */

import { fileURLToPath } from 'node:url'

const SHA_RE = /^[0-9a-f]{40}$/

/** The attested commit SHA, or null when the registry has no such version. Throws otherwise. */
export async function attestedCommit(name, version) {
  const res = await fetch(
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
  )
  if (res.status === 404) {
    // The attestations endpoint also 404s for a version that exists without
    // one (or before the registry has attested it), so ask for the version.
    const existing = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    )
    if (existing.status === 404) return null
    if (!existing.ok) throw new Error(`${name}@${version}: registry answered ${existing.status}`)
    throw new Error(`${name}@${version}: published without provenance, or not yet attested`)
  }
  if (!res.ok) throw new Error(`${name}@${version}: registry answered ${res.status}`)
  const body = await res.json()
  const slsa = body.attestations?.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1')
  if (!slsa) throw new Error(`${name}@${version}: published without SLSA provenance`)
  const statement = JSON.parse(
    Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
  )
  const sha = statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new Error(`${name}@${version}: provenance names no commit`)
  }
  return sha
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, version, ...extra] = process.argv.slice(2)
  if (!name || !version || extra.length > 0) {
    console.error('Usage: node scripts/npm-attested-commit.mjs <package> <version>')
    process.exit(1)
  }
  try {
    console.log((await attestedCommit(name, version)) ?? '')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
