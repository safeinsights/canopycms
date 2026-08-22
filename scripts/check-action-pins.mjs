#!/usr/bin/env node

/**
 * Fail when any third-party GitHub Action is referenced by a MUTABLE tag
 * rather than a full 40-character commit SHA.
 *
 * Why this exists rather than a comment asking nicely: pinning was done once as
 * a sweep, and a sweep only covers the tree it ran on. A job added on a sibling
 * branch and merged in afterwards arrived unpinned, and nothing noticed --
 * `ci.yml`'s own `example1-build` job sat on five floating tags while the epic
 * that pinned everything else was still open, claiming in its PR body that all
 * actions were pinned. That claim was true when written and false by the time
 * it merged.
 *
 * What a mutable tag costs, specifically: a tag is repointable by whoever owns
 * the action repo, so a maintainer-account compromise (the tj-actions/
 * changed-files mechanism) silently substitutes attacker code into a workflow
 * on its next run. `publish.yml` is the maximum-blast-radius case -- it holds
 * `id-token: write` for npm trusted publishing with provenance across five
 * public packages, and mints a token whose app can bypass main's PR rule.
 *
 * Scope: every workflow in .github/workflows, plus the workflow TEMPLATES the
 * CLI scaffolds into adopter repos and the checked-in example, since an
 * adopter inherits whatever those carry -- and `deploy-cms.yml`'s
 * configure-aws-credentials sits in front of a CDK-admin OIDC role.
 *
 * Local `uses: ./...` references are exempt: they resolve inside this repo at
 * the same commit, so there is no third party to compromise. `docker://` refs
 * are flagged, since a floating image tag has the same mutability problem.
 */

import { readFileSync } from 'node:fs'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Files to scan, beyond every .github/workflows/*.yml. */
const EXTRA_TARGETS = [
  'packages/canopycms/src/cli/template-files/deploy-cms.yml.template',
  'examples/aws-deployment/deploy-cms.yml',
]

const SHA_RE = /^[0-9a-f]{40}$/
// `uses:` value up to the first whitespace or comment.
const USES_RE = /^\s*-?\s*uses:\s*(\S+)/

function collectTargets() {
  const workflowDir = path.join(ROOT, '.github', 'workflows')
  const workflows = existsSync(workflowDir)
    ? readdirSync(workflowDir)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => path.join('.github', 'workflows', f))
    : []
  return [...workflows, ...EXTRA_TARGETS.filter((f) => existsSync(path.join(ROOT, f)))]
}

const problems = []
let checked = 0

for (const rel of collectTargets()) {
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
  lines.forEach((line, i) => {
    const match = USES_RE.exec(line)
    if (!match) return
    const ref = match[1]
    // A workflow in this same repo, at this same commit.
    if (ref.startsWith('./')) return
    checked++
    const at = ref.lastIndexOf('@')
    if (at === -1) {
      problems.push(`${rel}:${i + 1} -- \`${ref}\` has no version at all`)
      return
    }
    const version = ref.slice(at + 1)
    if (!SHA_RE.test(version)) {
      problems.push(
        `${rel}:${i + 1} -- \`${ref}\` is pinned to a mutable ref, not a 40-char commit SHA`,
      )
    }
  })
}

if (problems.length > 0) {
  console.error(`\n❌ ${problems.length} unpinned action reference(s):\n`)
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\nPin each to a full commit SHA with the tag in a trailing comment, e.g.:\n' +
      '  uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n\n' +
      'Resolve a tag to its commit (dereferencing annotated tags) with:\n' +
      '  gh api repos/OWNER/REPO/commits/TAG --jq .sha\n',
  )
  process.exit(1)
}

console.log(`✅ all ${checked} third-party action references are SHA-pinned`)
