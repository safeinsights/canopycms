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

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
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

// Word budgets. A separate, explicit file list from findMarkdown() above: the
// root docs below, .claude/agents/*.md, docs/*.md, and every AGENTS.md and
// README.md under a package's src/ tree. CLAUDE.md is user-owned and stays out.

/** Root docs carrying a word budget. */
const BUDGET_ROOT_FILES = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'DEVELOPING.md',
  'README.md',
  'CODEBASE_GUIDE.md',
]

const budgetsPath = join(repoRoot, 'scripts', 'docs-budgets.json')

/** AGENTS.md and README.md anywhere under a package's src/ tree, skipping build output. */
function findAgentsAndReadme(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...findAgentsAndReadme(full))
    } else if (entry.name === 'AGENTS.md' || entry.name === 'README.md') {
      out.push(rel(full))
    }
  }
  return out
}

/** The explicit, sorted file list the word budget applies to. */
function findDocsBudgetFiles() {
  const files = new Set(BUDGET_ROOT_FILES)
  // Both non-recursive: docs/reviews/*.md are dated snapshots, out of scope.
  for (const dir of ['docs', '.claude/agents']) {
    const abs = join(repoRoot, dir)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.add(`${dir}/${entry.name}`)
    }
  }
  const packagesDir = join(repoRoot, 'packages')
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const srcDir = join(packagesDir, pkg.name, 'src')
      if (existsSync(srcDir)) {
        for (const f of findAgentsAndReadme(srcDir)) files.add(f)
      }
    }
  }
  return [...files].sort()
}

/** Toggles "in fence" on a fenced-code delimiter; the delimiter line itself does not count as prose. */
const FENCE_RE = /^\s*(?:```|~~~)/
/** An inline code span, removed before word-counting so code is never read as prose. */
const CODE_SPAN_RE = /`[^`]*`/g

/** A word is a whitespace-delimited token that contains at least one letter or digit. */
function isWordToken(token) {
  return /[a-z0-9]/i.test(token)
}

function countWords(text) {
  return text.split(/\s+/).filter((t) => t.length > 0 && isWordToken(t)).length
}

/**
 * Turns file content into per-line records for the word-budget checks below,
 * one pass shared by the section, marker and 25-word-item checks. A record
 * carries the raw line, the line with inline code spans stripped, and that
 * line's own word count. Lines inside a fenced code block -- including the
 * fence delimiters -- produce no record at all.
 */
function extractText(content) {
  const records = []
  let inFence = false
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (FENCE_RE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const stripped = raw.replace(CODE_SPAN_RE, '')
    records.push({ lineNo: i + 1, raw, stripped, words: countWords(stripped) })
  }
  return records
}

/**
 * Flags a line that narrates how something changed instead of stating the
 * current rule -- the shape this doc set keeps drifting back into. Kept as a
 * code constant rather than spelled out in prose here, so this comment itself
 * never becomes an example of what it flags.
 */
const HISTORY_MARKER_RE =
  /used to|previously|until 20\d\d|as of 20\d\d|\d{4}-\d\d-\d\d|PR #\d+|reviewer|review round|finding|\[(?:HIGH|MEDIUM|LOW)-\d+\]/i

/** Word-budget metrics for one in-scope file: total words, H2 section sizes, and history-marker lines. */
function computeMetrics(relPath) {
  const records = extractText(readFileSync(join(repoRoot, relPath), 'utf8'))
  const words = records.reduce((sum, r) => sum + r.words, 0)

  // An unfenced line starting with "## " opens a new named section; anything
  // before the first one belongs to "(preamble)".
  let currentSection = '(preamble)'
  const sectionWords = new Map([[currentSection, 0]])
  for (const r of records) {
    if (r.raw.startsWith('## ')) {
      currentSection = r.raw.slice(3).trim()
      if (!sectionWords.has(currentSection)) sectionWords.set(currentSection, 0)
    }
    sectionWords.set(currentSection, sectionWords.get(currentSection) + r.words)
  }
  let maxSection = '(preamble)'
  let maxSectionWords = 0
  for (const [name, count] of sectionWords) {
    if (count > maxSectionWords) {
      maxSection = name
      maxSectionWords = count
    }
  }

  const historyMatches = records
    .filter((r) => HISTORY_MARKER_RE.test(r.stripped))
    .map((r) => ({ lineNo: r.lineNo, text: r.stripped.trim().slice(0, 120) }))

  return {
    words,
    sectionWords,
    maxSection,
    maxSectionWords,
    historyMarkers: historyMatches.length,
    historyMatches,
  }
}

/** Reads the ratchet file's `files` map, or an empty map when it does not exist yet. */
function loadBudgets() {
  if (!existsSync(budgetsPath)) return {}
  const parsed = JSON.parse(readFileSync(budgetsPath, 'utf8'))
  return parsed.files ?? {}
}

const BASELINE_COMMENT =
  'Word-count ratchet read by scripts/check-docs.mjs (pnpm lint:docs). Regenerate with `node scripts/check-docs.mjs --write-baseline [--margin=<pct>] [--allow-raise]`: words and maxSectionWords are written as actual plus the margin, historyMarkers as the actual count, and a write that would raise any existing number is refused without --allow-raise. historyMarkers: null means that file is a dated changelog whose markers are not checked; the null is kept across rewrites.'

/**
 * Writes scripts/docs-budgets.json from the current actuals of every in-scope
 * file. Refuses to raise a number that is already in the file unless
 * `allowRaise` is set, so a branch cannot go green by rewriting its own budget.
 */
function writeBaseline(margin, allowRaise) {
  const existing = loadBudgets()
  const withMargin = (n) => Math.ceil(n * (1 + margin / 100))
  const out = { $comment: BASELINE_COMMENT, files: {} }
  const raises = []
  for (const f of findDocsBudgetFiles()) {
    const m = computeMetrics(f)
    const prior = existing[f]
    const entry = {
      historyMarkers: prior?.historyMarkers === null ? null : m.historyMarkers,
      maxSectionWords: withMargin(m.maxSectionWords),
      words: withMargin(m.words),
    }
    for (const key of Object.keys(entry)) {
      if (prior && typeof prior[key] === 'number' && entry[key] > prior[key]) {
        raises.push(`${f}: ${key} ${prior[key]} -> ${entry[key]}`)
      }
    }
    out.files[f] = entry
  }
  if (raises.length > 0 && !allowRaise) {
    console.error(
      `❌ refusing to raise ${raises.length} budget number(s); pass --allow-raise to do it on purpose:`,
    )
    for (const r of raises) console.error(`    ${r}`)
    process.exit(1)
  }
  writeFileSync(budgetsPath, JSON.stringify(out, null, 2) + '\n')
  const files = Object.keys(out.files)
  console.log(
    `✅ wrote word budgets for ${files.length} file(s) to ${rel(budgetsPath)} (margin ${margin}%${raises.length > 0 ? `, ${raises.length} raised` : ''})`,
  )
}

/** Restricts a report to the in-scope files named on the command line, or all of them. */
function reportFiles(named) {
  const all = findDocsBudgetFiles()
  if (named.length === 0) return all
  const unknown = named.filter((f) => !all.includes(f))
  if (unknown.length > 0) {
    console.error(`❌ not in the budget scope: ${unknown.join(', ')}`)
    process.exit(1)
  }
  return named
}

/** Prints a markdown table of current metrics per file, plus a total row. */
function printReport(files) {
  console.log('| file | words | max H2 section | section words | markers |')
  console.log('| --- | --- | --- | --- | --- |')
  let totalWords = 0
  let totalMarkers = 0
  for (const f of files) {
    const m = computeMetrics(f)
    totalWords += m.words
    totalMarkers += m.historyMarkers
    console.log(
      `| ${f} | ${m.words} | ${m.maxSection} | ${m.maxSectionWords} | ${m.historyMarkers} |`,
    )
  }
  console.log(`| TOTAL | ${totalWords} | - | - | ${totalMarkers} |`)
}

/** Prints one row per H2 section (the preamble included) for each file. */
function printSections(files) {
  console.log('| file | H2 section | words |')
  console.log('| --- | --- | --- |')
  for (const f of files) {
    for (const [name, count] of computeMetrics(f).sectionWords) {
      console.log(`| ${f} | ${name} | ${count} |`)
    }
  }
}

// 25-word cap on list items and table cells in CODEBASE_GUIDE.md and module
// AGENTS.md files. A warning while the constant below is true; flipping it
// makes every hit an error.
const WARN_ONLY_LONG_ITEMS = true

/** CODEBASE_GUIDE.md plus every AGENTS.md under a package's src/ tree. */
function findWarningScopeFiles() {
  const files = ['CODEBASE_GUIDE.md']
  const packagesDir = join(repoRoot, 'packages')
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const srcDir = join(packagesDir, pkg.name, 'src')
      if (existsSync(srcDir)) {
        for (const f of findAgentsAndReadme(srcDir)) {
          if (f.endsWith('AGENTS.md')) files.push(f)
        }
      }
    }
  }
  return files.sort()
}

const LIST_ITEM_START_RE = /^\s*(?:[-*+]|\d+\.)\s/
const HEADING_RE = /^\s*#{1,6}\s/
/** A table separator row has nothing left once pipes, colons, dashes and space are removed. */
const TABLE_SEP_CHARS_RE = /[|:\s-]/g

/** Every list item (start line plus its indented continuation) whose total word count exceeds 25. */
function findLongListItems(records, filePath) {
  const out = []
  let i = 0
  while (i < records.length) {
    if (!LIST_ITEM_START_RE.test(records[i].raw)) {
      i++
      continue
    }
    const startLine = records[i].lineNo
    let words = records[i].words
    let j = i + 1
    while (j < records.length) {
      const line = records[j].raw
      if (line.trim() === '') break
      if (HEADING_RE.test(line)) break
      if (LIST_ITEM_START_RE.test(line)) break
      if (!/^\s/.test(line)) break
      words += records[j].words
      j++
    }
    if (words > 25) out.push({ file: filePath, lineNo: startLine, words })
    i = j
  }
  return out
}

/** Every table cell (header rows included) whose word count exceeds 25. */
function findLongTableCells(records, filePath) {
  const out = []
  for (const r of records) {
    if (!r.raw.trimStart().startsWith('|')) continue
    if (r.raw.replace(TABLE_SEP_CHARS_RE, '').length === 0) continue // separator row
    for (const cell of r.stripped.split('|')) {
      const trimmed = cell.trim()
      if (trimmed.length === 0) continue
      const words = countWords(trimmed)
      if (words > 25) out.push({ file: filePath, lineNo: r.lineNo, words })
    }
  }
  return out
}

// --- CLI flags: --write-baseline, --report and --sections short-circuit the checks ---

const argv = process.argv.slice(2)
const flagWriteBaseline = argv.includes('--write-baseline')
const flagReport = argv.includes('--report')
const flagSections = argv.includes('--sections')
const flagListLongItems = argv.includes('--list-long-items')
const flagAllowRaise = argv.includes('--allow-raise')
const marginArg = argv.find((a) => a.startsWith('--margin='))
const margin = marginArg ? Number(marginArg.slice('--margin='.length)) : 0
const namedFiles = argv.filter((a) => !a.startsWith('--'))

if (flagWriteBaseline && (flagReport || flagSections)) {
  console.error('❌ --write-baseline cannot be combined with --report or --sections')
  process.exit(1)
}
if (!Number.isFinite(margin) || margin < 0) {
  console.error('❌ --margin must be a non-negative percentage, e.g. --margin=3')
  process.exit(1)
}

if (flagWriteBaseline) {
  writeBaseline(margin, flagAllowRaise)
  process.exit(0)
}

if (flagReport || flagSections) {
  const files = reportFiles(namedFiles)
  if (flagReport) printReport(files)
  if (flagReport && flagSections) console.log('')
  if (flagSections) printSections(files)
  process.exit(0)
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

// --- check 4: every in-scope doc has a budget entry, and every entry names a real file ---
const inScopeFiles = findDocsBudgetFiles()
const budgets = loadBudgets()

for (const f of inScopeFiles) {
  if (!(f in budgets)) {
    problems.push({
      kind: 'missing doc budget',
      file: f,
      line: null,
      message: `add it: run \`node scripts/check-docs.mjs --write-baseline\` or add "${f}" by hand`,
    })
  }
}
for (const f of Object.keys(budgets)) {
  if (!existsSync(join(repoRoot, f))) {
    problems.push({ kind: 'stale doc budget', file: f, line: null, message: 'remove it' })
  }
}

// --- checks 5-7: word, section-word and history-marker ceilings ---
for (const f of inScopeFiles) {
  const budget = budgets[f]
  if (!budget) continue // already reported by check 4 above

  const metrics = computeMetrics(f)

  if (metrics.words > budget.words) {
    problems.push({
      kind: 'doc over word ceiling',
      file: f,
      line: null,
      message: `${metrics.words} words, ceiling ${budget.words}`,
    })
  }

  for (const [name, count] of metrics.sectionWords) {
    if (count > budget.maxSectionWords) {
      problems.push({
        kind: 'doc section over ceiling',
        file: f,
        line: null,
        message: `"${name}" has ${count} words, ceiling ${budget.maxSectionWords}`,
      })
    }
  }

  if (budget.historyMarkers !== null && metrics.historyMarkers > budget.historyMarkers) {
    problems.push({
      kind: 'doc history markers over budget',
      file: f,
      line: null,
      message: `${metrics.historyMarkers} lines, budget ${budget.historyMarkers}`,
    })
    for (const marker of metrics.historyMatches) {
      problems.push({
        kind: 'doc history markers over budget',
        file: f,
        line: marker.lineNo,
        message: marker.text,
      })
    }
  }
}

// --- check 8: 25-word cap on list items and table cells, warn-only while WARN_ONLY_LONG_ITEMS ---
const longItems = []
for (const f of findWarningScopeFiles()) {
  const records = extractText(readFileSync(join(repoRoot, f), 'utf8'))
  longItems.push(...findLongListItems(records, f), ...findLongTableCells(records, f))
}
longItems.sort((a, b) => b.words - a.words)
for (const item of longItems) {
  problems.push({
    kind: 'list item or table cell over 25 words',
    severity: WARN_ONLY_LONG_ITEMS ? 'warn' : 'error',
    file: item.file,
    line: item.lineNo,
    message: `${item.words} words`,
  })
}

const errors = problems.filter((p) => p.severity !== 'warn')
const warnings = problems.filter((p) => p.severity === 'warn')

function printGrouped(list, log) {
  for (const kind of [...new Set(list.map((p) => p.kind))]) {
    log(`  ${kind}:`)
    for (const p of list.filter((x) => x.kind === kind)) {
      const loc = p.line != null ? `${p.file}:${p.line}` : p.file
      log(`    ${loc} -- ${p.message}`)
    }
    log('')
  }
}

if (errors.length === 0) {
  console.log(
    `✅ docs cite real paths, links and entrypoints, and stay within word budgets (${markdownFiles.length} files checked, ${inScopeFiles.length} budgeted)`,
  )
} else {
  console.error(`❌ docs have ${errors.length} problem(s):\n`)
  printGrouped(errors, (l) => console.error(l))
  console.error(
    'Run `pnpm lint:docs` after fixing. See scripts/check-docs.mjs for the scope rules.',
  )
}

if (warnings.length > 0) {
  console.log(
    `⚠️ ${warnings.length} warning(s), not failing the run; the first 10 shown, --list-long-items prints all:\n`,
  )
  printGrouped(flagListLongItems ? warnings : warnings.slice(0, 10), (l) => console.log(l))
}

process.exit(errors.length === 0 ? 0 : 1)
