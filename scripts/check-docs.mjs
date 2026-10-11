#!/usr/bin/env node
// Factual guard for the agent-facing documentation layer: backticked repo
// paths must exist, relative markdown links must resolve, and our own
// package import specifiers must resolve against the real `exports` map.
// Also enforces a per-file word budget and a history-marker cap, or for a
// changelog a per-entry cap (see docs-budgets.json, HISTORY_MARKER_RE and
// isChangelogBudget below). SCOPE is narrower than
// "every markdown file" -- only where a path functions as an INSTRUCTION;
// see EXCLUDED below. Dependency-free apart from git itself.
//
// Usage: node scripts/check-docs.mjs [file...]
//        node scripts/check-docs.mjs --write-baseline [--margin=N] [--allow-raise]
//        node scripts/check-docs.mjs --write-baseline --only <file> [--only <file>...] --allow-raise
//        node scripts/check-docs.mjs --self-test
//        node scripts/check-docs.mjs --report | --sections | --list-long-items

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => relative(repoRoot, p)

/**
 * Markdown that is a dated snapshot or a prose backlog, not an instruction:
 * docs/reviews/ cites files as they were, which is accurate history rather
 * than drift, and future-tasks/ and BACKLOG.md cite files that don't exist
 * yet (planned work) or live in sibling repos -- future-tasks/ has its own
 * checker (check-future-tasks.mjs) for the links that ARE navigable.
 */
const EXCLUDED = [
  'docs/reviews',
  '.claude/future-tasks',
  'node_modules',
  '.git',
  // Other sessions' checkouts (git-ignored), each a full copy of the repo.
  '.claude/worktrees',
  'dist',
  'BACKLOG.md',
  // Sample site content for the editor round-trip test; its links are site URLs.
  'packages/canopycms/src/editor/fields/__fixtures__',
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

/**
 * Ask git which of these paths are ignored, so a doc describing a generated
 * tree (`worker/dist`, `.canopy-dev`, `.scaffold-synth`) is not flagged just
 * because a clean checkout doesn't have it yet. Batched -- one subprocess.
 */
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
  /used to|previously|until 20\d\d|as of 20\d\d|\d{4}-\d\d-\d\d|PR #\d+|review (?:round|pass)|found by (?:a |the )?review|review findings?|findings? (?:from|of) (?:a |the )?review|\[(?:HIGH|MEDIUM|LOW)-\d+\]/i

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

/**
 * A changelog entry (`historyMarkers: null` plus `maxEntryWords`) caps each `###`
 * entry under `## Unreleased` instead of the whole file and its sections: a
 * changelog grows with every change until a release consolidates it, so only
 * the size of one entry is something its author controls.
 */
function isChangelogBudget(budget) {
  return budget.historyMarkers === null
}

/** Why a budget entry has the wrong shape, or null; a missing key would silently skip its check. */
function budgetShapeError(budget) {
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) {
    return 'must be an object'
  }
  const isCount = (v) => Number.isInteger(v) && v >= 0
  const keys = Object.keys(budget).sort().join(',')
  if (isChangelogBudget(budget)) {
    if (keys === 'historyMarkers,maxEntryWords' && isCount(budget.maxEntryWords)) return null
    return 'a changelog entry (historyMarkers: null) takes exactly historyMarkers and maxEntryWords, a whole number'
  }
  if (
    keys === 'historyMarkers,maxSectionWords,words' &&
    isCount(budget.historyMarkers) &&
    isCount(budget.maxSectionWords) &&
    isCount(budget.words)
  ) {
    return null
  }
  return 'takes exactly historyMarkers, maxSectionWords and words, each a whole number'
}

/**
 * One line's text outside HTML comments, code spans removed, given whether a
 * comment is open at its start. An unclosed `<!--` carries over to later lines
 * only where CommonMark opens an HTML block, at the start of a line (up to three
 * spaces); anywhere else, or quoted in a code span, it is literal text. `<!-->`
 * and `<!--->` are complete empty comments.
 */
function stripHtmlComments(line, inComment) {
  let rest = line
  if (inComment) {
    const close = rest.indexOf('-->')
    if (close === -1) return { kept: '', inComment: true }
    rest = rest.slice(close + 3)
  }
  rest = rest.replace(CODE_SPAN_RE, '')
  let kept = ''
  for (;;) {
    const open = rest.indexOf('<!--')
    if (open === -1) return { kept: kept + rest, inComment: false }
    const after = rest.slice(open + 4)
    let close
    if (after.startsWith('>')) close = 1
    else if (after.startsWith('->')) close = 2
    else {
      const end = after.indexOf('-->')
      close = end === -1 ? -1 : end + 3
    }
    if (close === -1) {
      const opensBlock = !inComment && kept === '' && /^ {0,3}$/.test(rest.slice(0, open))
      return opensBlock ? { kept: '', inComment: true } : { kept: kept + rest, inComment: false }
    }
    kept += rest.slice(0, open) + ' '
    rest = after.slice(close)
  }
}

/**
 * The text of an ATX heading of exactly `level` -- up to three leading spaces,
 * optional closing hashes -- or null. Parsed in steps rather than one pattern,
 * whose optional closing-hash group is the backtracking shape `lint:scripts`
 * rejects.
 */
function atxHeading(line, level) {
  const open = /^ {0,3}(#+)[ \t]/.exec(line)
  if (!open || open[1].length !== level) return null
  const text = line.slice(open[0].length).trim()
  const closing = /(?:^|[ \t])#+$/.exec(text)
  return closing ? text.slice(0, closing.index).trim() : text
}

/**
 * Measures each `###` entry under a changelog's `## Unreleased` section and
 * returns those whose words, heading line included, exceed `cap`, plus whether
 * the section exists at all: without it nothing would be capped, so the caller
 * reports its absence. An entry runs to the next `###` or `##` heading; fenced
 * code and HTML comments (the entry template) are not read. Entries under
 * `## Released` are exempt: release consolidation is where the file shrinks.
 */
function measureChangelog(content, cap) {
  const entries = []
  let hasUnreleased = false
  let inUnreleased = false
  let inFence = false
  let inComment = false
  let current = null
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // Inside a comment a fence delimiter is comment text, as in an HTML block.
    if (!inComment && FENCE_RE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const startedInComment = inComment
    const stripped = stripHtmlComments(raw, inComment)
    inComment = stripped.inComment
    const h2 = startedInComment ? null : atxHeading(raw, 2)
    if (h2 !== null) {
      inUnreleased = h2 === 'Unreleased'
      hasUnreleased ||= inUnreleased
      current = null
      continue
    }
    if (!inUnreleased) continue
    const h3 = startedInComment ? null : atxHeading(raw, 3)
    if (h3 !== null) {
      current = { heading: h3, lineNo: i + 1, words: 0 }
      entries.push(current)
    }
    if (current) current.words += countWords(stripped.kept)
  }
  return { hasUnreleased, over: entries.filter((e) => e.words > cap) }
}

/**
 * Headroom an `--only` raise adds over the measured count: 2%, at least 10 and
 * at most 40 words, so a large doc's raise never hands it hundreds of free words.
 */
const ONLY_RAISE_MARGIN_PCT = 2
const ONLY_RAISE_MIN_WORDS = 10
const ONLY_RAISE_MAX_WORDS = 40

function withRaiseMargin(n) {
  const pct = Math.ceil((n * ONLY_RAISE_MARGIN_PCT) / 100)
  return n + Math.max(ONLY_RAISE_MIN_WORDS, Math.min(pct, ONLY_RAISE_MAX_WORDS))
}

/**
 * The budget file a `--write-baseline` run would write, and the raises it makes.
 * `measure(file)` returns that file's metrics.
 *
 * Without `only`, every in-scope file is rewritten from actuals plus `margin`
 * percent. With `only`, every other entry is copied unchanged, and the named
 * files change only the numbers they have outgrown, each raised to the
 * measured count plus `withRaiseMargin`'s headroom (history markers to the
 * exact count), so the next small edit is not refused at zero slack. A
 * changelog entry is kept as it is in both modes: its `maxEntryWords` is
 * edited by hand. A raise is any number written above the one already there,
 * and `refused` is set when there is one without `allowRaise`.
 */
function planBaseline({ existing, files, measure, margin, only, allowRaise }) {
  const withMargin = (n) => Math.ceil(n * (1 + margin / 100))
  const raises = []
  const errors = []
  const noteRaises = (f, prior, entry) => {
    for (const key of Object.keys(entry)) {
      if (prior && typeof prior[key] === 'number' && entry[key] > prior[key]) {
        raises.push(`${f}: ${key} ${prior[key]} -> ${entry[key]}`)
      }
    }
  }

  if (only) {
    const out = { ...existing }
    for (const f of only) {
      const prior = existing[f]
      if (!files.includes(f)) {
        errors.push(`${f}: not in the budget scope`)
        continue
      }
      if (prior && isChangelogBudget(prior)) {
        errors.push(`${f}: a changelog's maxEntryWords is edited by hand in docs-budgets.json`)
        continue
      }
      const m = measure(f)
      const raiseTo = (key, actual, pad) =>
        !prior || typeof prior[key] !== 'number' || actual > prior[key] ? pad(actual) : prior[key]
      const entry = {
        historyMarkers: raiseTo('historyMarkers', m.historyMarkers, (n) => n),
        maxSectionWords: raiseTo('maxSectionWords', m.maxSectionWords, withRaiseMargin),
        words: raiseTo('words', m.words, withRaiseMargin),
      }
      noteRaises(f, prior, entry)
      out[f] = entry
    }
    const sorted = Object.fromEntries(
      Object.keys(out)
        .sort()
        .map((f) => [f, out[f]]),
    )
    return { files: sorted, raises, errors, refused: raises.length > 0 && !allowRaise }
  }

  const out = {}
  for (const f of files) {
    const prior = existing[f]
    if (prior && isChangelogBudget(prior)) {
      out[f] = prior
      continue
    }
    const m = measure(f)
    const entry = {
      historyMarkers: m.historyMarkers,
      maxSectionWords: withMargin(m.maxSectionWords),
      words: withMargin(m.words),
    }
    noteRaises(f, prior, entry)
    out[f] = entry
  }
  return { files: out, raises, errors, refused: raises.length > 0 && !allowRaise }
}

const BASELINE_COMMENT =
  'Word-count ratchet read by scripts/check-docs.mjs (pnpm lint:docs). Regenerate with `node scripts/check-docs.mjs --write-baseline [--margin=<pct>] [--allow-raise]`: words and maxSectionWords are written as actual plus the margin, historyMarkers as the actual count, and a write that would raise any existing number is refused without --allow-raise. Raise one file with `--write-baseline --only <file> --allow-raise`: it leaves every other entry alone and raises only the numbers that file has outgrown, to the count plus 2% (at least 10 and at most 40 words). historyMarkers: null with maxEntryWords marks a dated changelog: its markers, total and sections are not checked, each ### entry under ## Unreleased is capped at maxEntryWords, and the entry is kept as written across rewrites.'

/**
 * Writes scripts/docs-budgets.json from `planBaseline`. Refuses to raise a
 * number that is already in the file unless `allowRaise` is set, so a branch
 * cannot go green by rewriting its own budget.
 */
function writeBaseline(margin, allowRaise, only) {
  const plan = planBaseline({
    existing: loadBudgets(),
    files: findDocsBudgetFiles(),
    measure: computeMetrics,
    margin,
    only,
    allowRaise,
  })
  if (plan.errors.length > 0) {
    for (const e of plan.errors) console.error(`❌ ${e}`)
    process.exit(1)
  }
  if (plan.refused) {
    console.error(
      `❌ refusing to raise ${plan.raises.length} budget number(s); pass --allow-raise to do it on purpose:`,
    )
    for (const r of plan.raises) console.error(`    ${r}`)
    process.exit(1)
  }
  writeFileSync(
    budgetsPath,
    JSON.stringify({ $comment: BASELINE_COMMENT, files: plan.files }, null, 2) + '\n',
  )
  const scope = only ? only.join(', ') : `${Object.keys(plan.files).length} file(s)`
  const how = only ? 'raise margin 2%, 10 to 40 words' : `margin ${margin}%`
  console.log(
    `✅ wrote word budgets for ${scope} to ${rel(budgetsPath)} (${how}${plan.raises.length > 0 ? `, ${plan.raises.length} raised` : ''})`,
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
// AGENTS.md files. Every hit is an error; set the constant to true only for the
// duration of a rewrite that has to land in stages.
const WARN_ONLY_LONG_ITEMS = false

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

/**
 * Checks the changelog entry cap and `planBaseline` against in-memory inputs,
 * run as the first step of `pnpm lint:docs` so it executes in CI.
 */
function selfTest() {
  const failures = []
  const expect = (label, ok) => {
    if (!ok) failures.push(`  ${label}`)
  }

  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
  const changelog = [
    '# Guide',
    '## Unreleased',
    words(50),
    '### Short entry',
    words(10),
    '### Long entry',
    words(20),
    '```',
    words(100),
    '```',
    '<!--',
    '### Template entry',
    words(100),
    '-->',
    '## Released',
    '### 0.0.1',
    '#### Old long entry',
    words(100),
  ].join('\n')
  const { hasUnreleased, over } = measureChangelog(changelog, 15)
  expect('entry cap: the Unreleased section is found', hasUnreleased)
  expect(
    `entry cap: only "Long entry" (22 words, heading included) is over, got ${JSON.stringify(over)}`,
    over.length === 1 &&
      over[0].heading === 'Long entry' &&
      over[0].words === 22 &&
      over[0].lineNo === 6,
  )
  expect(
    'entry cap: an entry exactly at the cap passes',
    measureChangelog(changelog, 22).over.length === 0,
  )
  const overOf = (lines) => measureChangelog(lines.join('\n'), 15).over
  expect(
    'entry cap: prose after a one-line HTML comment is counted',
    overOf(['## Unreleased', '### A', `<!-- note --> ${words(20)}`]).length === 1,
  )
  expect(
    'entry cap: prose after a comment closes is counted',
    overOf(['## Unreleased', '### A', '<!--', `x --> ${words(20)}`]).length === 1,
  )
  expect(
    'entry cap: an indented heading with closing hashes opens an entry',
    overOf(['  ## Unreleased ##', '### A', words(20), '   ### B ###', words(5)])
      .map((e) => e.heading)
      .join() === 'A',
  )
  for (const quoted of [
    'Wrap it in `<!--` and close it.',
    'An arrow <!-- in prose.',
    '<!--> An empty comment.',
    '<!---> An empty comment.',
  ]) {
    expect(
      `entry cap: "${quoted}" hides no later entry`,
      overOf(['## Unreleased', '### A', quoted, '### B', words(20)]).length === 1,
    )
  }
  expect(
    'entry cap: a quoted <!-- does not pair with a later -->',
    overOf(['## Unreleased', '### A', `\`<!--\` ${words(20)} <!-- c -->`]).length === 1,
  )
  expect(
    'entry cap: a fence line inside a comment does not hide its close',
    overOf(['## Unreleased', '<!--', '```', '-->', '### B', words(20)]).length === 1,
  )
  expect(
    'entry cap: a heading quoting code keeps its text',
    overOf(['## Unreleased', '### The `x` flag', words(20)])[0]?.heading === 'The `x` flag',
  )
  expect(
    'entry cap: a file without ## Unreleased reports it',
    !measureChangelog(['## [Unreleased]', '### A', words(20)].join('\n'), 15).hasUnreleased,
  )

  expect(
    'shape: a changelog entry is valid',
    budgetShapeError({ historyMarkers: null, maxEntryWords: 5 }) === null,
  )
  expect(
    'shape: a changelog entry keeping words is refused',
    budgetShapeError({ historyMarkers: null, maxEntryWords: 5, words: 9 }) !== null,
  )
  expect('shape: a null entry is refused', budgetShapeError(null) !== null)
  expect(
    'shape: a negative or fractional number is refused',
    budgetShapeError({ historyMarkers: 0, maxSectionWords: -1, words: 9 }) !== null &&
      budgetShapeError({ historyMarkers: null, maxEntryWords: 2.5 }) !== null,
  )
  expect(
    'shape: an extra key is refused',
    budgetShapeError({ historyMarkers: 0, maxSectionWords: 9, words: 9, maxEntryWords: 5 }) !==
      null,
  )
  expect(
    'shape: a ratchet entry is valid',
    budgetShapeError({ historyMarkers: 0, maxSectionWords: 9, words: 9 }) === null,
  )
  expect(
    'shape: a ratchet entry missing words is refused',
    budgetShapeError({ historyMarkers: 0, maxSectionWords: 9 }) !== null,
  )

  const existing = {
    'a.md': { historyMarkers: 0, maxSectionWords: 400, words: 1000 },
    'b.md': { historyMarkers: 0, maxSectionWords: 50, words: 90 },
    'log.md': { historyMarkers: null, maxEntryWords: 200 },
  }
  const metrics = {
    'a.md': { historyMarkers: 1, maxSectionWords: 300, words: 1500 },
    'b.md': { historyMarkers: 0, maxSectionWords: 10, words: 20 },
    'log.md': { historyMarkers: 7, maxSectionWords: 9000, words: 9000 },
  }
  const base = { existing, files: Object.keys(metrics), measure: (f) => metrics[f], margin: 0 }

  const onlyA = planBaseline({ ...base, only: ['a.md'] })
  expect('--only: other entries are copied unchanged', onlyA.files['b.md'] === existing['b.md'])
  expect(
    '--only: a changelog entry is copied unchanged',
    onlyA.files['log.md'] === existing['log.md'],
  )
  expect(
    `--only: a raise adds 2% (1500 -> 1530), got ${onlyA.files['a.md'].words}`,
    onlyA.files['a.md'].words === 1530,
  )
  expect(
    `--only: a number not outgrown stays put, got ${onlyA.files['a.md'].maxSectionWords}`,
    onlyA.files['a.md'].maxSectionWords === 400,
  )
  expect(
    '--only: history markers rise to the exact count',
    onlyA.files['a.md'].historyMarkers === 1,
  )
  expect(
    `--only: both raises are reported, got ${JSON.stringify(onlyA.raises)}`,
    onlyA.raises.length === 2,
  )
  expect('--only: a raise without --allow-raise is refused', onlyA.refused)
  expect(
    '--only: a raise with --allow-raise is not refused',
    !planBaseline({ ...base, only: ['a.md'], allowRaise: true }).refused,
  )

  const smallMetrics = {
    ...metrics,
    'b.md': { historyMarkers: 0, maxSectionWords: 60, words: 100 },
  }
  const onlyB = planBaseline({ ...base, measure: (f) => smallMetrics[f], only: ['b.md'] })
  expect(
    `--only: the margin is at least 10 words (100 -> 110), got ${onlyB.files['b.md'].words}`,
    onlyB.files['b.md'].words === 110 && onlyB.files['b.md'].maxSectionWords === 70,
  )

  const bigMetrics = {
    ...metrics,
    'b.md': { historyMarkers: 0, maxSectionWords: 10, words: 13034 },
  }
  const onlyBig = planBaseline({ ...base, measure: (f) => bigMetrics[f], only: ['b.md'] })
  expect(
    `--only: the margin is at most 40 words (13034 -> 13074), got ${onlyBig.files['b.md'].words}`,
    onlyBig.files['b.md'].words === 13074,
  )

  expect(
    '--only: naming a changelog is an error',
    planBaseline({ ...base, only: ['log.md'] }).errors.length === 1,
  )
  expect(
    '--only: naming an out-of-scope file is an error',
    planBaseline({ ...base, only: ['nope.md'] }).errors.length === 1,
  )

  const full = planBaseline(base)
  expect(
    'full write: a changelog entry is kept as written',
    full.files['log.md'] === existing['log.md'],
  )
  expect(
    'full write: an outgrown number is a raise',
    full.raises.some((r) => r.startsWith('a.md: words')),
  )
  expect('full write: a shrunk file is lowered to its actuals', full.files['b.md'].words === 20)

  const parsed = parseArgs(['--write-baseline', '--only=a.md', '--only', 'b.md', '--allow-raise'])
  expect(
    `args: both --only spellings are read, got ${JSON.stringify(parsed.onlyFiles)}`,
    parsed.onlyFiles?.join() === 'a.md,b.md',
  )
  expect('args: an unknown flag is refused', parseArgs(['--write-baseline', '--onl=a.md']).error)
  expect(
    'args: --write-baseline refuses a positional file',
    parseArgs(['--write-baseline', '--only', 'a.md', 'b.md']).error,
  )
  expect('args: a bare -- is ignored', parseArgs(['--', '--report']).flags?.has('--report'))
  expect('args: --only needs --write-baseline', parseArgs(['--only', 'a.md']).error)
  expect(
    'args: --only refuses --margin',
    parseArgs(['--write-baseline', '--only', 'a.md', '--margin=3']).error,
  )
  expect(
    'args: --report still takes files',
    parseArgs(['--report', 'a.md']).namedFiles?.[0] === 'a.md',
  )

  if (failures.length > 0) {
    console.error('check-docs self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log('check-docs self-test passed.')
}

// CLI flags: --self-test, --write-baseline, --report and --sections short-circuit the checks.

const KNOWN_FLAGS = new Set([
  '--self-test',
  '--write-baseline',
  '--report',
  '--sections',
  '--list-long-items',
  '--allow-raise',
])

/**
 * Parses the command line, or returns `{ error }`. Every flag is checked, so a
 * mistyped one can never fall through to a full `--write-baseline`.
 */
function parseArgs(argv) {
  const flags = new Set()
  const onlyFiles = []
  const namedFiles = []
  let marginArg = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue // pnpm passes `pnpm lint:docs -- --report` through verbatim
    if (a === '--only' || a.startsWith('--only=')) {
      const value = a === '--only' ? argv[++i] : a.slice('--only='.length)
      if (!value || value.startsWith('--')) {
        return { error: '--only takes a file path, e.g. --only docs/concurrency.md' }
      }
      onlyFiles.push(value)
    } else if (a.startsWith('--margin=')) {
      marginArg = a.slice('--margin='.length)
    } else if (KNOWN_FLAGS.has(a)) {
      flags.add(a)
    } else if (a.startsWith('--')) {
      return { error: `unknown flag ${a}` }
    } else {
      namedFiles.push(a)
    }
  }
  const margin = marginArg === null ? 0 : Number(marginArg)
  if (flags.has('--write-baseline') && (flags.has('--report') || flags.has('--sections'))) {
    return { error: '--write-baseline cannot be combined with --report or --sections' }
  }
  if (flags.has('--write-baseline') && namedFiles.length > 0) {
    return {
      error: `--write-baseline names files with --only, not as arguments: ${namedFiles.join(' ')}`,
    }
  }
  if (onlyFiles.length > 0 && (!flags.has('--write-baseline') || marginArg !== null)) {
    return {
      error: '--only goes with --write-baseline, and sets its own margin instead of --margin',
    }
  }
  if (marginArg === '' || !Number.isFinite(margin) || margin < 0) {
    return { error: '--margin must be a non-negative percentage, e.g. --margin=3' }
  }
  return { flags, onlyFiles, namedFiles, margin }
}

const args = parseArgs(process.argv.slice(2))
if (args.error) {
  console.error(`❌ ${args.error}`)
  process.exit(1)
}
const { onlyFiles, namedFiles, margin } = args
const flagSelfTest = args.flags.has('--self-test')
const flagWriteBaseline = args.flags.has('--write-baseline')
const flagReport = args.flags.has('--report')
const flagSections = args.flags.has('--sections')
const flagListLongItems = args.flags.has('--list-long-items')
const flagAllowRaise = args.flags.has('--allow-raise')

if (flagSelfTest) {
  selfTest()
  process.exit(0)
}
if (flagWriteBaseline) {
  writeBaseline(margin, flagAllowRaise, onlyFiles.length > 0 ? onlyFiles : null)
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

    // Check 1: a backticked repo path must exist, so a stale doc can't point
    // an agent at a module that no longer does.
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const p = candidateRepoPath(m[1].trim())
      if (!p || PLACEHOLDERS.has(p)) continue
      if (!existsSync(join(repoRoot, p))) {
        missingCandidates.push({ path: p, file: rel(file), line: lineNo })
      }
    }

    // Check 2: relative markdown links resolve against the LINKING FILE's own
    // directory, not the repo root, so a doc keeps working after it moves.
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

    // Check 3: our own import specifiers must resolve to a real subpath
    // export, so a copy-pasteable example doesn't hand an adopter a build error.
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

// Check 4: every in-scope doc has a budget entry, and every entry names a real file.
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

// Checks 5-7: word, section-word and history-marker ceilings, or a changelog's entry cap.
for (const f of inScopeFiles) {
  if (!(f in budgets)) continue // already reported by check 4 above
  const budget = budgets[f]

  const shapeError = budgetShapeError(budget)
  if (shapeError) {
    problems.push({ kind: 'malformed doc budget', file: f, line: null, message: shapeError })
    continue
  }

  if (isChangelogBudget(budget)) {
    const content = readFileSync(join(repoRoot, f), 'utf8')
    const changelog = measureChangelog(content, budget.maxEntryWords)
    if (!changelog.hasUnreleased) {
      problems.push({
        kind: 'changelog has no ## Unreleased section',
        file: f,
        line: null,
        message:
          'maxEntryWords caps the ### entries under `## Unreleased`; without that heading nothing is checked',
      })
    }
    for (const entry of changelog.over) {
      problems.push({
        kind: 'changelog entry over word cap',
        file: f,
        line: entry.lineNo,
        message: `"${entry.heading}" has ${entry.words} words, cap ${budget.maxEntryWords}`,
      })
    }
    continue
  }

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

  if (metrics.historyMarkers > budget.historyMarkers) {
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

// Check 8: 25-word cap on list items and table cells, warn-only while WARN_ONLY_LONG_ITEMS.
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

// Check 9: every release this branch contains has a section in the migration guide.
//
// Entries are written under `## Unreleased` and promoted by hand, so a release that
// ships without anyone touching the file leaves its entries filed as unreleased. Three
// releases accumulated that way once (0.0.64 through 0.0.66, ~1,150 lines), which tells
// an adopter that everything they are already running has not shipped yet — neutralising
// the "Now deletable" lists the document calls its own point.
//
// Tag reachability is the signal: if `vX.Y.Z` is an ancestor of HEAD, this branch
// contains that release and the guide on this branch should account for it.
//
// This check is INERT ON A SHALLOW CLONE, which is what CI checks out — no history, no
// tags, nothing to compare. That is deliberate rather than overlooked: lint-staged runs
// `lint:docs` on every commit touching `**/*.md`, locally, where the full history is
// present, so the check fires at the moment someone edits this file. CI is the backstop
// for everything else here, not for this one.
{
  const guide = 'docs/adopter-migration.md'
  const guidePath = join(repoRoot, guide)
  let shallow = true
  let tags = []
  try {
    shallow =
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim() === 'true'
    if (!shallow) {
      tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*.*.*'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .map((t) => t.trim().replace(/^v/, ''))
        .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
    }
  } catch {
    tags = []
  }

  if (!shallow && tags.length > 0 && existsSync(guidePath)) {
    const headings = readFileSync(guidePath, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('### '))
      .map((l) => l.slice(4).trim())
    const named = new Set()
    let floor = null
    for (const h of headings) {
      const exact = /^(\d+\.\d+\.\d+)$/.exec(h)
      if (exact) named.add(exact[1])
      const catchAll = /^(\d+\.\d+\.\d+) and earlier$/.exec(h)
      if (catchAll) floor = catchAll[1]
    }
    const cmp = (a, b) => {
      const x = a.split('.').map(Number)
      const y = b.split('.').map(Number)
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
      return 0
    }
    for (const v of tags) {
      if (named.has(v)) continue
      if (floor && cmp(v, floor) <= 0) continue
      problems.push({
        kind: 'released version has no section in the migration guide',
        file: guide,
        line: null,
        message: `\`${v}\` is tagged and reachable from HEAD -- add a \`### ${v}\` section under \`## Released\` and move its entries out of \`## Unreleased\`, demoting each from \`###\` to \`####\``,
      })
    }
  }
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
