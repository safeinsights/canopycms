#!/usr/bin/env node
// Factual guard for the agent-facing documentation layer.
//
// This checks two things a reader cannot verify by reading, and that rotted
// badly enough by 2026-08-23 to be worth a script:
//
//   1. Repo paths cited in backticks actually exist. AGENTS.md documented a
//      `packages/canopycms/src/middleware/` module that never existed;
//      `.claude/agents/update-codebase-guide.md` listed nine directories to
//      monitor, of which SIX did not exist, so the agent charged with keeping
//      CODEBASE_GUIDE.md accurate was blind to most of what it watched;
//      `init-maintenance.md` pointed at `cli/templates/` (really
//      `cli/template-files/`); the baseline-review skill sent a reviewer to
//      `src/asset-store.ts` (really `src/assets/`).
//   2. Relative markdown links resolve. Splitting the root AGENTS.md into
//      per-directory files on 2026-08-23 moved prose that had been written
//      relative to the repo root four levels down, silently breaking every
//      `[docs/concurrency.md](docs/concurrency.md)` in it. Targets resolve
//      against the LINKING FILE's own directory, the same rule
//      check-future-tasks.mjs uses and for the same reason.
//   3. Import specifiers for OUR packages resolve against the real `exports`
//      maps. ARCHITECTURE.md advertised a `canopycms/config` entrypoint twice
//      AND shipped a copy-pasteable fence importing from it; CODEBASE_GUIDE.md
//      cited `canopycms/schema`; canopycms-auth-clerk's own README told
//      adopters to import from `canopycms/next`. None of the three exist, so
//      anyone copying those lines gets a build error.
//
// SCOPE is deliberate, and narrower than "every markdown file". A path is only
// worth checking where it functions as an INSTRUCTION. Excluded:
//
//   - `docs/reviews/` -- dated snapshots. A July report citing a file that has
//     since moved is accurate history, not drift.
//   - `.claude/future-tasks/` and `BACKLOG.md` -- prose backlogs. They cite
//     files that do not exist YET (planned tests), and files in sibling repos.
//     This is the same call scripts/check-future-tasks.mjs already documents
//     for not checking source citations there. That backlog has its own
//     checker for the links that ARE navigable.
//
// Two more sources of legitimate non-existence are filtered rather than
// excluded, so the surrounding file still gets checked:
//
//   - Gitignored paths. Docs describe generated trees (`worker/dist`,
//     `.canopy-dev`, `.scaffold-synth`) that are absent from a clean checkout.
//     Asked of git directly, and asked in both bare and trailing-slash form:
//     `git check-ignore` does not match a directory-only pattern against a
//     path that does not currently exist.
//   - Tutorial placeholders, listed explicitly below with a reason each.
//
// Dependency-free apart from git itself, so it runs the same way in CI and
// pre-commit.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => relative(repoRoot, p)

/** Markdown that is a dated snapshot or a prose backlog, not an instruction. */
const EXCLUDED = [
  'docs/reviews',
  '.claude/future-tasks',
  'node_modules',
  '.git',
  'dist',
  'BACKLOG.md',
]

/**
 * Top-level segments that denote a real repo path when seen in backticks.
 *
 * `docs/` is deliberately NOT here: Canopy content collections are addressed by
 * path, so README prose says things like "organized by path (e.g. `posts`,
 * `docs/guides`)" about CONTENT, not about this repo's docs directory.
 */
const REPO_PATH_ROOTS = ['packages/', 'apps/', 'scripts/']

/** Tutorial placeholders -- deliberately not real files. */
const PLACEHOLDERS = new Set([
  'packages/canopycms/src/api/my-module.ts', // DEVELOPING.md "adding an endpoint" walkthrough
  'packages/my-app', // canopycms/README.md monorepo-adopter example
])

/** Subpath exports for each workspace package, by package name. */
function loadPackageExports() {
  const map = new Map()
  for (const dir of ['packages', 'apps']) {
    const base = join(repoRoot, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgPath = join(base, entry.name, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (!pkg.name) continue
      // A subpath counts as real if EITHER map exposes it: `./test-utils` is in
      // `exports` but deliberately kept out of `publishConfig.exports`, and a
      // contributor doc may legitimately reference it for workspace-internal use.
      const subpaths = new Set()
      for (const src of [pkg.exports, pkg.publishConfig?.exports]) {
        if (src && typeof src === 'object') for (const k of Object.keys(src)) subpaths.add(k)
      }
      if (subpaths.size > 0) map.set(pkg.name, subpaths)
    }
  }
  return map
}

const packageExports = loadPackageExports()
const packageNamesByLength = [...packageExports.keys()].sort((a, b) => b.length - a.length)

/** Ask git which of these paths are ignored. Batched -- one subprocess. */
function gitIgnored(paths) {
  if (paths.length === 0) return new Set()
  // Both forms: a directory-only pattern (`foo/`) does not match a bare `foo`
  // that does not exist on disk.
  const probe = [...paths, ...paths.map((p) => p + '/')]
  let out = ''
  try {
    out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: repoRoot,
      input: probe.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch (err) {
    // git check-ignore exits 1 when nothing matched; that is not an error.
    out = err.stdout ?? ''
  }
  return new Set(
    out
      .split('\n')
      .filter(Boolean)
      .map((p) => (p.endsWith('/') ? p.slice(0, -1) : p)),
  )
}

function isExcluded(absPath) {
  const r = rel(absPath)
  return EXCLUDED.some((d) => r === d || r.startsWith(d + '/'))
}

function findMarkdown(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (isExcluded(full)) continue
    if (entry.isDirectory()) out.push(...findMarkdown(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * A backticked token is only a repo path when it starts with a known top-level
 * directory. Anything glob-like or templated is skipped -- docs legitimately
 * write `packages/canopycms/src/**` and `docs/reviews/<YYYY-MM>.md` to describe
 * a shape rather than name a file.
 */
function candidateRepoPath(token) {
  if (!REPO_PATH_ROOTS.some((r) => token.startsWith(r))) return null
  if (/[*?{}<>|\s]/.test(token)) return null
  // Strip a trailing line anchor (`file.ts:123`, `file.ts:12-34`, `file.ts:1,2`)
  // and trailing sentence punctuation authors include inside the backticks.
  //
  // The anchor pattern is a flat character class rather than the more precise
  // `/:\d+(-\d+)?(,\d+(-\d+)?)*$/`, whose nested quantifiers are the
  // polynomial-backtracking shape `lint:scripts` rejects (and that this repo
  // hand-rolls scanners elsewhere to avoid). Slightly looser -- it would also
  // strip `:1--2` -- which costs nothing here, since a real repo path has no
  // colon in it at all.
  let p = token.replace(/:[\d,-]+$/, '').replace(/[.,;:]+$/, '')
  if (p.endsWith('/')) p = p.slice(0, -1)
  return p.length > 0 ? p : null
}

const markdownFiles = findMarkdown(repoRoot).sort()
const problems = []
const missingCandidates = [] // { path, file, line } -- resolved against git-ignore in one batch

for (const file of markdownFiles) {
  const lines = readFileSync(file, 'utf8').split('\n')

  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1

    // --- check 1: backticked repo paths exist ---
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const p = candidateRepoPath(m[1].trim())
      if (!p || PLACEHOLDERS.has(p)) continue
      if (!existsSync(join(repoRoot, p))) {
        missingCandidates.push({ path: p, file: rel(file), line: lineNo })
      }
    }

    // --- check 2: relative markdown links resolve against the linking file ---
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].trim()
      // Skip absolute URLs, anchors, and mailto -- only in-repo links are ours.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
      const withoutAnchor = target.split('#')[0]
      if (!withoutAnchor) continue
      const resolved = resolve(dirname(file), withoutAnchor)
      if (!existsSync(resolved)) {
        problems.push({
          kind: 'relative link target does not exist',
          file: rel(file),
          line: lineNo,
          message: `${target} -> ${rel(resolved)}`,
        })
      }
    }

    // --- check 3: our own import specifiers resolve to a real subpath export ---
    for (const m of line.matchAll(/from '([^']+)'|require\('([^']+)'\)/g)) {
      const spec = m[1] ?? m[2]
      if (!spec) continue
      // Longest package name first, so `canopycms-next` is not read as `canopycms`.
      const pkgName = packageNamesByLength.find((n) => spec === n || spec.startsWith(n + '/'))
      if (!pkgName) continue
      const exports = packageExports.get(pkgName)
      const subpath = spec === pkgName ? '.' : './' + spec.slice(pkgName.length + 1)
      if (!exports.has(subpath)) {
        problems.push({
          kind: 'import specifier not in exports map',
          file: rel(file),
          line: lineNo,
          message: `'${spec}' -- ${pkgName} exposes ${[...exports].sort().join(', ')}`,
        })
      }
    }
  }
}

const ignored = gitIgnored([...new Set(missingCandidates.map((c) => c.path))])
for (const c of missingCandidates) {
  if (ignored.has(c.path)) continue // generated tree, absent from a clean checkout
  problems.push({
    kind: 'path does not exist',
    file: c.file,
    line: c.line,
    message: `\`${c.path}\``,
  })
}

if (problems.length === 0) {
  console.log(
    `✅ docs cite real paths, links and entrypoints (${markdownFiles.length} files checked)`,
  )
  process.exit(0)
}

console.error(`❌ docs have ${problems.length} factual problem(s):\n`)
for (const kind of [...new Set(problems.map((p) => p.kind))]) {
  console.error(`  ${kind}:`)
  for (const p of problems.filter((x) => x.kind === kind)) {
    console.error(`    ${p.file}:${p.line} -- ${p.message}`)
  }
  console.error('')
}
console.error('Run `pnpm lint:docs` after fixing. See scripts/check-docs.mjs for the scope rules.')
process.exit(1)
