#!/usr/bin/env node
// Consistency guard for the .claude/future-tasks/ backlog: every task file's
// frontmatter (priority, adopters, summary), dead links, `[[wikilink]]` syntax,
// and index.md rows whose file already moved to resolved/. Dependency-free and
// whole-tree, so it runs the same in CI and in pre-commit.
//
// A task's priority and summary live in its own frontmatter, not in index.md,
// so two PRs that each file a task never edit the same lines. index.md holds
// only the hand-ranked lists; `--index` prints the per-priority tables.
//
// Usage: node scripts/check-future-tasks.mjs [--fix] [--index]
// `--fix` repairs link paths whose target moved; everything else is reported
// and left for a human. `--index` prints the P0-P3, adopter-side, program and
// resolved tables after a clean check.

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tasksDir = join(repoRoot, '.claude', 'future-tasks')
const indexPath = join(tasksDir, 'index.md')

const rel = (p) => relative(repoRoot, p)

/** Every .md file under the backlog tree, recursively. */
function findMarkdown(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findMarkdown(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out.sort()
}

/**
 * Markdown links, skipping fenced code blocks so documented example snippets
 * are not mistaken for real links -- several task files embed shell one-liners
 * that mention .md paths. Line numbers come from the enumeration index, so
 * skipping fenced lines does not shift them.
 */
function collectLinks(file) {
  const links = []
  let inFence = false
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (/^\s*```/.test(raw)) {
        inFence = !inFence
        return
      }
      if (inFence) return
      // safe-regex flags star height only: `[^"]*` sits inside the optional
      // `(?:\s+"...")?` group (matches at most once), while `[^)\s]+` before
      // it excludes whitespace that `\s+` then requires -- disjoint, so they
      // cannot ambiguate; linear, not exponential.
      // eslint-disable-next-line security/detect-unsafe-regex
      for (const m of raw.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        links.push({ target: m[1], line: i + 1, raw })
      }
    })
  return links
}

// Only same-repo .md targets are navigable links. Task files also cite source
// files and repo-root placeholders as prose, relative to the repo root, not
// as links -- checking those would be pure false positives.
function isCheckableTarget(target) {
  if (/^(https?:|mailto:|#)/.test(target)) return false
  return target.split('#')[0].endsWith('.md')
}

const problems = []
const report = (kind, file, line, message) =>
  problems.push({ kind, file: rel(file), line, message })

const markdownFiles = findMarkdown(tasksDir)

// `--fix` repairs link paths that broke because their TARGET moved.
//
// Resolving a task means `git mv`-ing it into resolved/, which invalidates both
// the links inside it (siblings are now one level up) and the links pointing at
// it (now behind resolved/). That churn is mechanical -- the checker already
// knows the target exists and where -- so it is repaired here rather than by
// hand, which is why buildTargetIndex() below spans more than the backlog tree.
//
// Deliberately NOT auto-fixed: a "stale open row" (taking a resolved task out of
// a ranked list is a semantic edit) and missing or invalid frontmatter (its
// summary has to be written by whoever knows what the task is). Those stay hard
// errors.
const shouldFix = process.argv.includes('--fix')
const shouldIndex = process.argv.includes('--index')

/**
 * basename -> [absolute path], over every place a task file legitimately links:
 * the backlog tree, repo-root docs, and docs/. A basename occurring twice is
 * left out entirely -- guessing between two candidates would silently retarget a
 * link, which is worse than the manual edit this replaces.
 */
function buildTargetIndex() {
  const byName = new Map()
  const add = (p) => {
    const key = basename(p)
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(p)
  }
  for (const f of markdownFiles) add(f)
  for (const dir of [repoRoot, join(repoRoot, 'docs')]) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) add(join(dir, entry.name))
    }
  }
  return byName
}

const targetIndex = shouldFix ? buildTargetIndex() : null
/** file -> [{ from, to }] rewrites, applied once per file after the scan. */
const pendingFixes = new Map()

/** Records a rewrite when the target exists somewhere unambiguous. */
function planFix(file, target) {
  const wanted = basename(target.split('#')[0])
  const candidates = targetIndex.get(wanted)
  if (!candidates || candidates.length !== 1) return false
  // `relative()` yields exactly the form this backlog writes by hand:
  // `foo.md`, `resolved/foo.md`, or `../foo.md`. No `./` prefix is added --
  // descendant links are conventionally bare here.
  const corrected = relative(dirname(file), candidates[0])
  const fragment = target.includes('#') ? `#${target.split('#').slice(1).join('#')}` : ''
  const replacement = `${corrected}${fragment}`
  if (replacement === target) return false
  if (!pendingFixes.has(file)) pendingFixes.set(file, [])
  pendingFixes.get(file).push({ from: target, to: replacement })
  return true
}

// Targets resolve against the LINKING FILE's own directory, not the repo
// root: task files link each other with relative paths, and a root-relative
// check would call a miscounted `../` clean until the file containing it
// moves. Row links in index.md are reported as "orphan row" rather than
// "dead link" so the two orphan directions read distinctly, but it's the same
// resolution rule.
for (const file of markdownFiles) {
  for (const { target, line, raw } of collectLinks(file)) {
    if (!isCheckableTarget(target)) continue
    const resolved = resolve(dirname(file), target.split('#')[0])
    if (existsSync(resolved)) continue
    if (shouldFix && planFix(file, target)) continue
    const isIndexRow = file === indexPath && /^\|\s*\[/.test(raw)
    if (isIndexRow) {
      report(
        'orphan row (row with no file)',
        file,
        line,
        `row links "${target}", which does not exist`,
      )
    } else {
      const hint = existsSync(join(tasksDir, 'resolved', basename(target)))
        ? ' (a file of that name exists in resolved/ -- fix the relative path)'
        : ''
      report(
        'dead link',
        file,
        line,
        `"${target}" does not resolve from ${rel(dirname(file))}/${hint}`,
      )
    }
  }
}

// `[[wikilink]]` cross-references must not appear at all: they render as
// literal `[[text]]` on GitHub and are invisible to checks 1-3 above, so a
// broken one rots unnoticed. Every cross-reference has to be a real markdown
// link to stay both clickable and checkable.
//
// Only kebab-case slugs are flagged. `[[...slug]]` (Next.js optional catch-all
// routes) and `[[:space:]]` (POSIX class) appear legitimately in task prose and
// are not link syntax.
for (const file of markdownFiles) {
  let inFence = false
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (/^\s*```/.test(raw)) {
        inFence = !inFence
        return
      }
      if (inFence) return
      for (const m of raw.matchAll(/\[\[([a-z0-9][a-z0-9-]*)\]\]/g)) {
        report(
          'wikilink (use a markdown link)',
          file,
          i + 1,
          `"[[${m[1]}]]" is not clickable on GitHub and bypasses the link check -- write [${m[1]}](${m[1]}.md), adjusting the relative path`,
        )
      }
    })
}

// index.md's tables rank OPEN work only, so a row linking a file that lives in
// resolved/ overstates what's left. Both spellings count: a bare name that
// moved, and the `resolved/` path `--fix` rewrites it to. Table rows only.
{
  const resolvedDir = join(tasksDir, 'resolved')
  const lines = readFileSync(indexPath, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    if (!/^\|/.test(line)) continue
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!isCheckableTarget(m[1])) continue
      const path = m[1].split('#')[0]
      const name = basename(path)
      const target = resolve(tasksDir, path)
      const inResolved =
        dirname(target) === resolvedDir ||
        (!existsSync(target) && existsSync(join(resolvedDir, name)))
      if (inResolved) {
        report(
          'stale open row',
          indexPath,
          i + 1,
          `"${name}" is ranked as open but the file lives in resolved/ -- take it out of the list`,
        )
      }
    }
  }
}

// Frontmatter: the record of each task's priority and summary. The format is a
// strict subset of YAML, parsed here so the script stays dependency-free:
// `key: value` lines, plus `summary: >-` with its text on indented lines.
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'adopter-side', 'program']
const ADOPTERS = ['KB', 'MKT', 'BOTH', 'NEITHER']
const KEYS = ['priority', 'adopters', 'summary']

/** Returns { fields, body } or { error }. */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n'))
    return { error: 'missing frontmatter (the file must start with ---)' }
  const end = text.indexOf('\n---\n', 3)
  if (end === -1) return { error: 'frontmatter has no closing ---' }
  const fields = {}
  let open = null
  for (const line of text.slice(4, end).split('\n')) {
    if (open && line.startsWith('  ')) {
      fields[open] = fields[open] ? `${fields[open]} ${line.trim()}` : line.trim()
      continue
    }
    open = null
    const m = /^([a-z]+): ?(.*)$/.exec(line)
    if (!m) return { error: `unparseable frontmatter line "${line}"` }
    const [, key, value] = m
    if (!KEYS.includes(key))
      return { error: `unknown frontmatter key "${key}" (allowed: ${KEYS.join(', ')})` }
    if (key in fields) return { error: `duplicate frontmatter key "${key}"` }
    if (value === '>-') {
      open = key
      fields[key] = ''
    } else {
      fields[key] = value.trim()
    }
  }
  return { fields, body: text.slice(end + 5) }
}

// A body may restate the priority (`# [P2] Title`, `**Priority:** P2`), and an
// edit to one copy alone would leave two answers. Only the first statement in
// the opening lines is compared; later prose about past priorities is history.
const BODY_PRIORITY = [/^#\s*\[(P[0-3])\]/, /Priority:?\**:?\s*\**\s*(P[0-3])\b/i]
function bodyPriority(body) {
  for (const line of body.split('\n').slice(0, 10)) {
    for (const rx of BODY_PRIORITY) {
      const m = rx.exec(line)
      if (m) return m[1]
    }
  }
  return null
}

/** file -> fields, for `--index`. */
const tasks = new Map()
for (const file of markdownFiles) {
  if (file === indexPath) continue
  const isResolved = relative(tasksDir, file).startsWith(`resolved/`)
  const { fields, body, error } = parseFrontmatter(readFileSync(file, 'utf8'))
  if (error) {
    report('frontmatter', file, 1, error)
    continue
  }
  if (!fields.summary) report('frontmatter', file, 1, 'summary is missing or empty')
  if (fields.adopters !== undefined && !ADOPTERS.includes(fields.adopters)) {
    report(
      'frontmatter',
      file,
      1,
      `adopters "${fields.adopters}" is not one of ${ADOPTERS.join(', ')}`,
    )
  }
  if (!isResolved) {
    if (!PRIORITIES.includes(fields.priority)) {
      report(
        'frontmatter',
        file,
        1,
        `priority "${fields.priority ?? ''}" is not one of ${PRIORITIES.join(', ')}`,
      )
    } else {
      const stated = bodyPriority(body)
      if (stated && /^P[0-3]$/.test(fields.priority) && stated !== fields.priority) {
        report(
          'priority disagreement',
          file,
          null,
          `frontmatter says ${fields.priority} but the body says ${stated} -- change both together`,
        )
      }
    }
  }
  tasks.set(file, { ...fields, isResolved })
}

// Apply `--fix` rewrites. Anchored on the `](target)` form rather than the
// bare target so a path that also appears as prose elsewhere in the file is left
// alone.
if (shouldFix && pendingFixes.size > 0) {
  let count = 0
  for (const [file, fixes] of pendingFixes) {
    let text = readFileSync(file, 'utf8')
    for (const { from, to } of fixes) {
      text = text.split(`](${from})`).join(`](${to})`)
      count++
    }
    writeFileSync(file, text)
  }
  console.log(`🔧 repaired ${count} link path(s) across ${pendingFixes.size} file(s):`)
  for (const [file, fixes] of pendingFixes) {
    for (const { from, to } of fixes) console.log(`    ${rel(file)}: ${from} -> ${to}`)
  }
  console.log('')
}

const SECTIONS = [
  ['P0', 'P0 — Blocks launch; data loss, security, or crash'],
  ['P1', 'P1 — High-impact correctness, or blocks a site launch'],
  ['P2', 'P2 — Enhancements, feature work, and moderate quality'],
  ['P3', 'P3 — Nice-to-have; low-impact'],
  ['adopter-side', 'Adopter-side work (owned by the adopter repo)'],
  ['program', 'Program records'],
  ['resolved', 'Resolved'],
]

/** A summary's relative `.md` links are written from its own file; re-point them from index.md's directory. */
function rebaseLinks(summary, file) {
  return summary.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (!isCheckableTarget(target)) return whole
    const [path, ...fragment] = target.split('#')
    const moved = relative(tasksDir, resolve(dirname(file), path))
    return `](${[moved, ...fragment].join('#')})`
  })
}

/** Markdown tables of every task, linked relative to index.md, by file name within a section. */
function renderIndex() {
  const out = []
  for (const [key, title] of SECTIONS) {
    const rows = [...tasks]
      .filter(([, t]) => (key === 'resolved' ? t.isResolved : !t.isResolved && t.priority === key))
      .sort(([a], [b]) => basename(a).localeCompare(basename(b)))
    out.push(`## ${title}`, '')
    if (rows.length === 0) {
      out.push('None.', '')
      continue
    }
    out.push('| File | Summary |', '| ---- | ------- |')
    for (const [file, t] of rows) {
      const tag = t.adopters ? ` [${t.adopters}]` : ''
      const summary = rebaseLinks(`${t.summary}${tag}`, file).replaceAll('|', '\\|')
      out.push(`| [${basename(file)}](${relative(tasksDir, file)}) | ${summary} |`)
    }
    out.push('')
  }
  return out.join('\n')
}

if (problems.length === 0) {
  if (shouldIndex) {
    console.log(renderIndex())
    process.exit(0)
  }
  console.log(`✅ future-tasks backlog is consistent (${markdownFiles.length} files checked)`)
  process.exit(0)
}

console.error(`❌ future-tasks backlog has ${problems.length} problem(s):\n`)
for (const kind of [...new Set(problems.map((p) => p.kind))]) {
  console.error(`  ${kind}:`)
  for (const p of problems.filter((x) => x.kind === kind)) {
    console.error(`    ${p.file}${p.line ? `:${p.line}` : ''} -- ${p.message}`)
  }
  console.error('')
}
const pathProblems = problems.filter(
  (p) => p.kind.startsWith('dead link') || p.kind.startsWith('orphan row'),
)
if (pathProblems.length > 0 && !shouldFix) {
  console.error(
    `${pathProblems.length} of these are link paths whose target exists elsewhere -- try \`pnpm lint:tasks --fix\`.`,
  )
}
console.error(
  'Run `pnpm lint:tasks` after fixing. See scripts/check-future-tasks.mjs for the rules.',
)
process.exit(1)
