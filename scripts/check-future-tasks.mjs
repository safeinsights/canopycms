#!/usr/bin/env node
// Consistency guard for the .claude/future-tasks/ backlog.
//
// The backlog is the repo's durable record of deferred work, and it rots in
// three specific ways that reviewers keep re-discovering by hand:
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
//
// Dependency-free and whole-tree, so it runs the same way in CI and in
// pre-commit (once per commit that touches the backlog, like lint:bundle).
//
// Scope note: only `.md` link targets are checked. Task files also cite source
// files (`packages/canopycms/src/config.ts`) and placeholders (`/figures/...`)
// as prose references written relative to the repo root, not as navigable
// links; checking those would be pure false positives.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
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

// --- Check 1 + 3b: link resolution, relative to each linking file's directory.
// Row links in index.md are split out as "orphan row" so the two orphan
// directions read distinctly in the output; they are the same resolution rule.
for (const file of markdownFiles) {
  for (const { target, line, raw } of collectLinks(file)) {
    if (!isCheckableTarget(target)) continue
    const resolved = resolve(dirname(file), target.split('#')[0])
    if (existsSync(resolved)) continue
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
console.error(
  'Run `pnpm lint:tasks` after fixing. See scripts/check-future-tasks.mjs for the rules.',
)
process.exit(1)
