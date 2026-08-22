#!/usr/bin/env node
// Consistency guard for the .claude/future-tasks/ backlog.
//
// Pass `--fix` to repair link paths whose target moved (see the fixer below);
// everything else is reported and left for a human.
//
// The backlog is the repo's durable record of deferred work, and it rots in
// four specific ways that reviewers keep re-discovering by hand:
//
//   1. Dead links. Task files link each other with RELATIVE paths, so moving a
//      file into resolved/ silently breaks every inbound link that did not move
//      with it. This is why targets are resolved against the LINKING FILE'S own
//      directory rather than the repo root -- both dead links found on
//      2026-08-13 were relative-path errors (one missing `../`, one with a
//      stale `../`) that a root-relative check would have called clean.
//   2. Stale open rows. index.md's open priority tables claim to list OPEN work
//      only, and program sequencing reads them, so a row whose file already
//      lives in resolved/ overstates the remaining work.
//   3. Orphans, in both directions: a task file no row points at, and a row
//      pointing at a file that does not exist.
//   4. `[[wikilinks]]`. They render as literal `[[text]]` on GitHub and were
//      invisible to checks 1-3, so they rotted silently: of the 41 present on
//      2026-08-13, 5 were already dead. All were converted to markdown links
//      and check 4 keeps them from returning.
//
// Dependency-free and whole-tree, so it runs the same way in CI and in
// pre-commit (once per commit that touches the backlog, like lint:bundle).
//
// Scope note: only `.md` link targets are checked. Task files also cite source
// files (`packages/canopycms/src/config.ts`) and placeholders (`/figures/...`)
// as prose references written relative to the repo root, not as navigable
// links; checking those would be pure false positives.

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
      // safe-regex flags star height only: `[^"]*` is inside the optional
      // `(?:\s+"...")?` group, which matches at most once, and `[^)\s]+`
      // before it excludes whitespace while `\s+` requires it -- disjoint, so
      // they cannot ambiguate. Measured 2026-08-22 at 0.5ms against a 60KB
      // adversarial input. This runs in the pre-commit hook, so it was worth
      // confirming by timing rather than by reading.
      // eslint-disable-next-line security/detect-unsafe-regex
      for (const m of raw.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        links.push({ target: m[1], line: i + 1, raw })
      }
    })
  return links
}

/** Only same-repo .md targets are navigable links worth resolving. */
function isCheckableTarget(target) {
  if (/^(https?:|mailto:|#)/.test(target)) return false
  return target.split('#')[0].endsWith('.md')
}

const problems = []
const report = (kind, file, line, message) =>
  problems.push({ kind, file: rel(file), line, message })

const markdownFiles = findMarkdown(tasksDir)

// --- `--fix`: repair link paths that broke because their TARGET moved.
//
// Resolving a task means `git mv`-ing it into resolved/, which invalidates both
// the links inside it (siblings are now one level up) and the links pointing at
// it (now behind resolved/). That churn is mechanical -- the checker already
// knows the target exists and where -- so it is repaired here rather than by
// hand. A 2026-08-13 audit moved 9 files and needed 13 hand-edits, one of which
// (a repo-root doc needing a third `../`) had no "exists in resolved/" hint to
// catch it, which is why the index below spans more than the backlog tree.
//
// Deliberately NOT auto-fixed: a "stale open row" (moving it to the Resolved
// section is a semantic edit, and the row's summary usually needs rewriting too)
// and an "orphan file" (its index row has to be written by whoever knows what
// the task is). Those stay hard errors.
const shouldFix = process.argv.includes('--fix')

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

// --- Check 1 + 3b: link resolution, relative to each linking file's directory.
// Row links in index.md are split out as "orphan row" so the two orphan
// directions read distinctly in the output; they are the same resolution rule.
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

// --- Check 4: `[[wikilink]]` cross-references.
//
// The backlog used to mix these with markdown links. They render as literal
// `[[text]]` on GitHub and were invisible to this script, so 5 of the 41 that
// existed on 2026-08-13 had rotted unnoticed -- including four pointing at a
// Claude *memory* filename rather than anything in the repo. All were converted
// to markdown links; this keeps them from coming back, so every cross-reference
// stays both clickable and checkable.
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

// --- Check 2: open-table rows whose target already lives in resolved/.
// Walks index.md down to the Resolved heading and looks at table rows only.
{
  const lines = readFileSync(indexPath, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    if (/^## Resolved/.test(line)) break
    if (!/^\|\s*\[/.test(line)) continue
    for (const m of line.matchAll(/\]\(([^)/\s]+\.md)\)/g)) {
      if (existsSync(join(tasksDir, 'resolved', m[1]))) {
        report(
          'stale open row',
          indexPath,
          i + 1,
          `"${m[1]}" is listed as open but the file lives in resolved/ -- move the row to the Resolved section`,
        )
      }
    }
  }
}

// --- Check 3a: task files no index row points at.
// "Indexed" means referenced anywhere in index.md, not necessarily as its own
// row: some files are deliberately tracked as sub-items inside another row's
// summary, and demanding a dedicated row for those would be noise.
{
  const indexed = new Set(
    collectLinks(indexPath)
      .filter(({ target }) => isCheckableTarget(target))
      .map(({ target }) => basename(target.split('#')[0])),
  )
  for (const file of markdownFiles) {
    if (file === indexPath) continue
    if (!indexed.has(basename(file))) {
      report(
        'orphan file (file with no row)',
        file,
        null,
        'no row in index.md references this file',
      )
    }
  }
}

// --- Apply `--fix` rewrites. Anchored on the `](target)` form rather than the
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

if (problems.length === 0) {
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
