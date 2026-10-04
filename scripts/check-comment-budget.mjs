#!/usr/bin/env node
// Ratchet on comment volume in non-test source.
//
// Walks the filesystem (not git) under a fixed set of package scope roots,
// classifies each line of each in-scope file as code, comment, or blank, and
// compares the results against scripts/comment-budget.json. A file's comments
// are grouped into runs (maximal sequences of comment lines, blanks allowed
// between); each run has a length cap, each directory bucket and each package
// has a ratio cap, and history-marker phrasing is counted and capped per
// package. `--write-baseline` regenerates the budget file from the current
// tree. `--report` and `--markers` print the underlying numbers without
// checking them.
//
// Dependency-free apart from node itself, so it runs the same way in CI and
// pre-commit.

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative, extname, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const budgetPath = join(repoRoot, 'scripts', 'comment-budget.json')
const rel = (p) => relative(repoRoot, p).split(sep).join('/')

/** Package key -> one or more scope roots, each walked and bucketed on its own. */
const PACKAGE_ROOTS = {
  canopycms: ['packages/canopycms/src'],
  'canopycms-next': ['packages/canopycms-next/src'],
  'canopycms-cdk': [
    'packages/canopycms-cdk/src',
    'packages/canopycms-cdk/lambda',
    'packages/canopycms-cdk/canary',
    'packages/canopycms-cdk/worker',
    'packages/canopycms-cdk/test-support',
  ],
  'canopycms-auth-clerk': ['packages/canopycms-auth-clerk/src'],
  'canopycms-auth-dev': ['packages/canopycms-auth-dev/src'],
  scripts: ['scripts'],
}

const FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])

/** A directory anywhere on the path prunes the whole subtree. */
const EXCLUDED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  '__test__',
  '__tests__',
  '__integration__',
  'test-utils',
])

/** Basename shapes that are test/story/declaration files, not source to budget. */
const EXCLUDED_BASENAME_PATTERNS = [/\.test\./, /\.stories\./, /\.d\.ts$/]

/** Scaffold templates: not real code, just text with a .ts-shaped extension. */
const EXCLUDED_SUBTREES = ['packages/canopycms/src/cli/template-files']

/** Generated files, excluded individually rather than by directory. */
const EXCLUDED_FILES = new Set([
  'packages/canopycms/src/api/client.ts',
  'packages/canopycms/src/api/__test__/mock-client.ts',
])

/** A comment line that reads as leftover review process rather than a durable rule. */
const HISTORY_MARKER_RE =
  /used to|previously|until 20\d\d|as of 20\d\d|\d{4}-\d\d-\d\d|PR #\d+|review (?:round|pass)|found by (?:a |the )?review|review findings?|findings? (?:from|of) (?:a |the )?review|\[(?:HIGH|MEDIUM|LOW)-\d+\]/i

/** Lines that read like a comment but are tooling instructions, not documentation. */
const REFERENCE_DIRECTIVE_RE = /^\/\/\/\s*<reference/
const TOOLING_DIRECTIVE_RE = /^(?:\/\/|\/\*)\s*(?:eslint-|@ts-|v8 ignore|@vitest-environment)/

function isDirectiveLine(t) {
  return t.startsWith('#!') || REFERENCE_DIRECTIVE_RE.test(t) || TOOLING_DIRECTIVE_RE.test(t)
}

function walk(absDir, out) {
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_SEGMENTS.has(entry.name)) continue
      walk(join(absDir, entry.name), out)
    } else if (entry.isFile()) {
      out.push(join(absDir, entry.name))
    }
  }
}

/** Every in-scope file, tagged with the package and directory bucket it belongs to. */
function discoverFiles() {
  const files = []
  for (const [pkg, roots] of Object.entries(PACKAGE_ROOTS)) {
    for (const root of roots) {
      const absRoot = join(repoRoot, root)
      if (!existsSync(absRoot)) continue
      const collected = []
      walk(absRoot, collected)
      for (const abs of collected) {
        const r = rel(abs)
        if (EXCLUDED_FILES.has(r)) continue
        if (EXCLUDED_SUBTREES.some((s) => r === s || r.startsWith(s + '/'))) continue
        const base = basename(abs)
        if (EXCLUDED_BASENAME_PATTERNS.some((re) => re.test(base))) continue
        if (!FILE_EXTENSIONS.has(extname(abs))) continue
        const fromRoot = relative(absRoot, abs).split(sep).join('/')
        const firstSeg = fromRoot.split('/')[0]
        const bucket = fromRoot.includes('/') ? `${root}/${firstSeg}` : root
        files.push({ abs, rel: r, pkg, bucket })
      }
    }
  }
  return files
}

/**
 * Classifies every line of `text` as code, comment, or blank, and reports
 * comment runs and history-marker matches. See the module header for the
 * classification order this implements.
 */
function scanFile(text) {
  const lines = text.split('\n')
  let inBlock = false
  let code = 0
  let comment = 0
  const runs = []
  const markerLines = []

  let runActive = false
  let runStart = 0
  let runEnd = 0
  let runLen = 0

  const openRun = (lineNo) => {
    if (!runActive) {
      runActive = true
      runStart = lineNo
      runLen = 0
    }
    runEnd = lineNo
    runLen++
  }
  const closeRun = () => {
    if (runActive) {
      runs.push({ start: runStart, end: runEnd, length: runLen })
      runActive = false
    }
  }
  const recordMarker = (lineNo, raw) => {
    if (HISTORY_MARKER_RE.test(raw)) {
      markerLines.push({ line: lineNo, text: raw.trim().slice(0, 120) })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineNo = i + 1
    const t = raw.trimStart()

    if (inBlock) {
      comment++
      openRun(lineNo)
      recordMarker(lineNo, raw)
      if (t.includes('*/')) inBlock = false
    } else if (t === '') {
      // blank: neither code nor comment, does not break a run
    } else if (isDirectiveLine(t)) {
      code++
      closeRun()
    } else if (t.startsWith('//')) {
      comment++
      openRun(lineNo)
      recordMarker(lineNo, raw)
    } else if (t.startsWith('/*') || t.startsWith('{/*')) {
      comment++
      openRun(lineNo)
      recordMarker(lineNo, raw)
      const opener = t.startsWith('{/*') ? '{/*' : '/*'
      if (!t.slice(opener.length).includes('*/')) inBlock = true
    } else {
      code++
      closeRun()
    }
  }
  closeRun()

  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0)
  return { code, comment, maxRun, runs, markerLines }
}

const args = process.argv.slice(2)
const writeBaseline = args.includes('--write-baseline')
const showReport = args.includes('--report')
const showMarkers = args.includes('--markers')
const allowRaise = args.includes('--allow-raise')
const marginArg = args.find((a) => a.startsWith('--margin='))
const margin = marginArg ? Number(marginArg.slice('--margin='.length)) : 0
if (!Number.isFinite(margin) || margin < 0) {
  console.error('❌ --margin must be a non-negative percentage, e.g. --margin=2')
  process.exit(1)
}

const files = discoverFiles()
const fileResults = files.map((f) => {
  const text = readFileSync(f.abs, 'utf8')
  const scan = scanFile(text)
  const ratio = scan.code > 0 ? scan.comment / scan.code : 0
  return { ...f, ...scan, ratio }
})

function newAgg() {
  return { code: 0, comment: 0, maxRun: 0, markers: 0 }
}

const dirAgg = new Map() // bucket -> agg, plus pkg
const pkgAgg = new Map() // pkg -> agg
for (const f of fileResults) {
  if (!dirAgg.has(f.bucket)) dirAgg.set(f.bucket, { ...newAgg(), pkg: f.pkg })
  const d = dirAgg.get(f.bucket)
  d.code += f.code
  d.comment += f.comment
  d.maxRun = Math.max(d.maxRun, f.maxRun)
  d.markers += f.markerLines.length

  if (!pkgAgg.has(f.pkg)) pkgAgg.set(f.pkg, newAgg())
  const p = pkgAgg.get(f.pkg)
  p.code += f.code
  p.comment += f.comment
  p.maxRun = Math.max(p.maxRun, f.maxRun)
  p.markers += f.markerLines.length
}

const markersByPkg = new Map()
for (const f of fileResults) {
  for (const m of f.markerLines) {
    if (!markersByPkg.has(f.pkg)) markersByPkg.set(f.pkg, [])
    markersByPkg.get(f.pkg).push({ file: f.rel, line: m.line, text: m.text })
  }
}
for (const list of markersByPkg.values()) {
  list.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
}

function aggRatio(agg) {
  return agg.code > 0 ? agg.comment / agg.code : 0
}

function loadBudget() {
  return existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : { packages: {} }
}

// --- --write-baseline: regenerate scripts/comment-budget.json from actuals.
// Ratios get the margin; run caps and marker counts are written as measured.
// Raising any number already in the file needs --allow-raise, so a branch
// cannot go green by rewriting its own budget.
if (writeBaseline) {
  const discoveredBuckets = new Map()
  for (const f of fileResults) discoveredBuckets.set(f.bucket, f.pkg)
  const existing = loadBudget()
  const ceilRatio = (r) => Math.ceil(r * (1 + margin / 100) * 1000) / 1000
  const raises = []
  const noteRaise = (label, prior, next) => {
    if (typeof prior === 'number' && next > prior) raises.push(`${label} ${prior} -> ${next}`)
  }

  const packages = {}
  for (const pkg of Object.keys(PACKAGE_ROOTS).sort()) {
    const agg = pkgAgg.get(pkg)
    if (!agg) continue
    const directories = {}
    const bucketsForPkg = [...discoveredBuckets.entries()]
      .filter(([, p]) => p === pkg)
      .map(([b]) => b)
      .sort()
    for (const bucket of bucketsForPkg) {
      const d = dirAgg.get(bucket)
      const prior = existing.packages?.[pkg]?.directories?.[bucket]
      directories[bucket] = { maxRun: Math.max(d.maxRun, 30), ratio: ceilRatio(aggRatio(d)) }
      noteRaise(`${bucket} maxRun`, prior?.maxRun, directories[bucket].maxRun)
      noteRaise(`${bucket} ratio`, prior?.ratio, directories[bucket].ratio)
    }
    const prior = existing.packages?.[pkg]
    packages[pkg] = { directories, historyMarkers: agg.markers, ratio: ceilRatio(aggRatio(agg)) }
    noteRaise(`${pkg} historyMarkers`, prior?.historyMarkers, agg.markers)
    noteRaise(`${pkg} ratio`, prior?.ratio, packages[pkg].ratio)
  }

  if (raises.length > 0 && !allowRaise) {
    console.error(
      `❌ refusing to raise ${raises.length} budget number(s); pass --allow-raise to do it on purpose:`,
    )
    for (const r of raises) console.error(`    ${r}`)
    process.exit(1)
  }

  const baseline = {
    $comment:
      'Comment-volume ratchet read by scripts/check-comment-budget.mjs (pnpm lint:comments). Regenerate with `node scripts/check-comment-budget.mjs --write-baseline [--margin=<pct>] [--allow-raise]`: ratios are written as actual plus the margin, run caps (floor 30) and marker counts as measured, and a write that would raise any existing number is refused without --allow-raise.',
    packages,
  }
  writeFileSync(budgetPath, JSON.stringify(baseline, null, 2) + '\n')
  const dirCount = Object.values(packages).reduce(
    (n, p) => n + Object.keys(p.directories).length,
    0,
  )
  console.log(
    `📝 wrote baseline: ${Object.keys(packages).length} package(s), ${dirCount} director(y/ies), margin ${margin}%${raises.length > 0 ? `, ${raises.length} raised` : ''}`,
  )
  process.exit(0)
}

// --- --report / --markers: print actuals, skip the checks ---
if (showReport || showMarkers) {
  const fmt = (r) => r.toFixed(3)
  if (showReport) {
    console.log('## Per-file\n')
    console.log('| file | code | comment | ratio | max run | markers |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    for (const f of [...fileResults].sort((a, b) => a.rel.localeCompare(b.rel))) {
      console.log(
        `| ${f.rel} | ${f.code} | ${f.comment} | ${fmt(f.ratio)} | ${f.maxRun} | ${f.markerLines.length} |`,
      )
    }
    console.log('\n## Per-directory\n')
    console.log('| directory | code | comment | ratio | max run | markers |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    for (const bucket of [...dirAgg.keys()].sort()) {
      const d = dirAgg.get(bucket)
      console.log(
        `| ${bucket} | ${d.code} | ${d.comment} | ${fmt(aggRatio(d))} | ${d.maxRun} | ${d.markers} |`,
      )
    }
    console.log('\n## Per-package\n')
    console.log('| package | code | comment | ratio | max run | markers |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    let totalCode = 0
    let totalComment = 0
    let totalMaxRun = 0
    let totalMarkers = 0
    for (const pkg of [...pkgAgg.keys()].sort()) {
      const p = pkgAgg.get(pkg)
      totalCode += p.code
      totalComment += p.comment
      totalMaxRun = Math.max(totalMaxRun, p.maxRun)
      totalMarkers += p.markers
      console.log(
        `| ${pkg} | ${p.code} | ${p.comment} | ${fmt(aggRatio(p))} | ${p.maxRun} | ${p.markers} |`,
      )
    }
    const totalRatio = totalCode > 0 ? totalComment / totalCode : 0
    console.log(
      `| **total** | ${totalCode} | ${totalComment} | ${fmt(totalRatio)} | ${totalMaxRun} | ${totalMarkers} |`,
    )
  }
  if (showMarkers) {
    const all = [...fileResults]
      .flatMap((f) => f.markerLines.map((m) => ({ file: f.rel, line: m.line, text: m.text })))
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
    if (showReport) console.log('')
    for (const m of all) console.log(`${m.file}:${m.line} -- ${m.text}`)
  }
  process.exit(0)
}

// --- default mode: check actuals against scripts/comment-budget.json ---
const budget = loadBudget()

const problems = []
const addProblem = (kind, lines) =>
  problems.push({ kind, lines: Array.isArray(lines) ? lines : [lines] })

const discoveredPackages = new Set(fileResults.map((f) => f.pkg))
const discoveredBuckets = new Map()
for (const f of fileResults) discoveredBuckets.set(f.bucket, f.pkg)

// Check 1: coverage -- every discovered key has a budget entry, and vice versa.
for (const pkg of [...discoveredPackages].sort()) {
  if (!budget.packages?.[pkg]) {
    addProblem(
      'missing budget entry',
      `"${pkg}" -- add it: run \`node scripts/check-comment-budget.mjs --write-baseline\` or add "${pkg}" by hand`,
    )
  }
}
for (const bucket of [...discoveredBuckets.keys()].sort()) {
  const pkg = discoveredBuckets.get(bucket)
  const pkgBudget = budget.packages?.[pkg]
  if (pkgBudget && !pkgBudget.directories?.[bucket]) {
    addProblem(
      'missing budget entry',
      `"${bucket}" -- add it: run \`node scripts/check-comment-budget.mjs --write-baseline\` or add "${bucket}" by hand`,
    )
  }
}
for (const pkg of Object.keys(budget.packages ?? {}).sort()) {
  if (!discoveredPackages.has(pkg)) {
    addProblem('stale budget entry', `"${pkg}" -- remove it`)
    continue
  }
  for (const bucket of Object.keys(budget.packages[pkg].directories ?? {}).sort()) {
    if (discoveredBuckets.get(bucket) !== pkg) {
      addProblem('stale budget entry', `"${bucket}" -- remove it`)
    }
  }
}

// Check 2: history markers, per package.
for (const pkg of [...discoveredPackages].sort()) {
  const budgetEntry = budget.packages?.[pkg]
  if (!budgetEntry) continue
  const actual = pkgAgg.get(pkg).markers
  if (actual > budgetEntry.historyMarkers) {
    const detail = (markersByPkg.get(pkg) ?? []).map((m) => `${m.file}:${m.line} -- ${m.text}`)
    addProblem('history markers exceed budget', [
      `${pkg}: ${actual} marker(s) > budget ${budgetEntry.historyMarkers}`,
      ...detail,
    ])
  }
}

// Check 3: max comment-run length, per directory.
for (const f of fileResults) {
  const dirBudget = budget.packages?.[f.pkg]?.directories?.[f.bucket]
  if (!dirBudget) continue
  for (const run of f.runs) {
    if (run.length > dirBudget.maxRun) {
      addProblem(
        'comment run exceeds cap',
        `${f.rel}:${run.start}-${run.end} (${run.length} lines, cap ${dirBudget.maxRun})`,
      )
    }
  }
}

// Check 4: comment/code ratio, per directory.
for (const bucket of [...discoveredBuckets.keys()].sort()) {
  const pkg = discoveredBuckets.get(bucket)
  const dirBudget = budget.packages?.[pkg]?.directories?.[bucket]
  if (!dirBudget) continue
  const d = dirAgg.get(bucket)
  const actual = aggRatio(d)
  if (actual > dirBudget.ratio + 1e-9) {
    addProblem(
      'comment ratio exceeds budget (directory)',
      `${bucket}: actual ${actual.toFixed(3)} > budget ${dirBudget.ratio.toFixed(3)} (comment/code = ${d.comment}/${d.code})`,
    )
  }
}

// Check 5: comment/code ratio, per package (backstop over the whole package).
for (const pkg of [...discoveredPackages].sort()) {
  const budgetEntry = budget.packages?.[pkg]
  if (!budgetEntry) continue
  const p = pkgAgg.get(pkg)
  const actual = aggRatio(p)
  if (actual > budgetEntry.ratio + 1e-9) {
    addProblem(
      'comment ratio exceeds budget (package)',
      `${pkg}: actual ${actual.toFixed(3)} > budget ${budgetEntry.ratio.toFixed(3)} (comment/code = ${p.comment}/${p.code})`,
    )
  }
}

if (problems.length === 0) {
  const totalCode = fileResults.reduce((n, f) => n + f.code, 0)
  const totalComment = fileResults.reduce((n, f) => n + f.comment, 0)
  const totalRatio = totalCode > 0 ? totalComment / totalCode : 0
  console.log(
    `✅ comments within budget (${fileResults.length} files, ${totalCode} code lines, ${totalComment} comment lines, ratio ${totalRatio.toFixed(3)})`,
  )
  process.exit(0)
}

console.error(`❌ comment budget has ${problems.length} problem(s):\n`)
for (const kind of [...new Set(problems.map((p) => p.kind))]) {
  console.error(`  ${kind}:`)
  for (const p of problems.filter((x) => x.kind === kind)) {
    const [first, ...detail] = p.lines
    console.error(`    ${first}`)
    for (const line of detail) console.error(`        ${line}`)
  }
  console.error('')
}
console.error(
  'Run `pnpm lint:comments` after fixing. See scripts/check-comment-budget.mjs for the rules.',
)
process.exit(1)
