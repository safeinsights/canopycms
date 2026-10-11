#!/usr/bin/env node
// Assembles the adopter changelog from `.changeset/*.md`, and checks those files.
// Each changeset is one migration entry, or a later part of one. This script
// appends them to CHANGELOG.md's `## Unreleased` section, after the frozen
// legacy entries, with a table row each, and labels each with the first int
// prerelease whose tag (`v<x.y.z>-int.<N>`) carries the file. Labels and the
// "new since" handoff come from git tags alone, so the tag-dependent rules need
// full history. Needs git, @changesets/parse, github-slugger and
// mdast-util-from-markdown (root devDependencies).
//
// Usage: node scripts/migration-notes.mjs --check
//        node scripts/migration-notes.mjs --preview
//        node scripts/migration-notes.mjs --ship --version <v> --sha <40-hex> --out <path> [--summary <path>]
//        node scripts/migration-notes.mjs --self-test

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseChangesetFile } from '@changesets/parse'
import GithubSlugger, { slug as baseSlug } from 'github-slugger'
import { fromMarkdown } from 'mdast-util-from-markdown'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = 'https://github.com/safeinsights/canopycms'
const CHANGELOG = 'CHANGELOG.md'

const AREAS = [
  'AI',
  'Assets',
  'Auth',
  'Branches',
  'CDK',
  'Editing',
  'MDX',
  'Ops',
  'Preview',
  'Reading',
  'Refs',
  'Schema',
  'Worker',
]
const META_KEYS = ['area', 'action', 'row', 'extends', 'legacy']
/** Actions that ask nothing of an adopter: the entry may skip "To adopt" and release as a patch. */
const NO_ACTION = new Set(['None', 'Optional'])
const MAX_ACTION_WORDS = 5
const MAX_ROW_WORDS = 10
/** What @changesets/read@1.0.1 skips in `.changeset/`, besides dotfiles and non-`.md` files. */
const IGNORED_MD = [/^readme\.md$/i, 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
const INT_TAG_RE = /^v\d+\.\d+\.\d+-int\.([1-9]\d*)$/
/**
 * Hand-written int labels. The lookbehind skips a version such as
 * `0.0.68-int.101`, which names a build rather than labelling an entry.
 */
const INT_LABEL_RE = /(?<![\w.-])int\.\d+/
const NEXT_LABEL_RE = /\(next(?: int)?\)/i
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i
const HANDOFF =
  "If you upgraded from a build on another branch, compare the `<!-- changeset: … -->` slugs in your previous build's `CHANGELOG.md` (`npm pack canopycms@<old>` fetches it) with this one's: entries whose slug your old file lacks are new to you. Legacy entries above the changeset entries carry hand-written int labels."

/** Anchors the shipped `## This build` section takes, so no other heading may. */
const RESERVED_ANCHOR_RE = /^(?:this-build|(?:new|revised)-since-int\d+)$/

const problem = (file, line, message, severity = 'error') => ({ file, line, message, severity })
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isKebab = (s) => s.length > 0 && s.split('-').every((part) => /^[a-z0-9]+$/.test(part))
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length
/** `//host` is absolute; a single leading `/` is repo-root-relative, as GitHub renders it. */
const isAbsoluteUrl = (url) => ABSOLUTE_URL_RE.test(url) || url.startsWith('//')
const errorMessage = (err) => (err instanceof Error ? err.message : String(err))
/** Plain text made safe inside link text: no markup, so no nested link or emphasis. */
const escapeInline = (s) => s.replace(/[\\[\]*_`<>]/g, '\\$&')

/**
 * Whether a `.changeset/` entry name is a changeset, exactly as
 * @changesets/read@1.0.1 lists them: `.md`, not a dotfile, and not one of
 * IGNORED_MD (README.md in any case, the others in exact case).
 */
function isChangesetName(name) {
  return (
    name.endsWith('.md') &&
    !name.startsWith('.') &&
    !IGNORED_MD.some((p) => (typeof p === 'string' ? p === name : p.test(name)))
  )
}

/** Why a `row` would break its table link, or null: link text cannot hold a bare bracket. */
function rowMarkupProblem(row) {
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\') {
      if (i === row.length - 1) return 'ends in a lone `\\`'
      i++
    } else if (row[i] === '[' || row[i] === ']') {
      return 'has an unescaped `[` or `]`; write `\\[` or `\\]`'
    }
  }
  return null
}

function lineAt(text, offset) {
  let n = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Text nodes outside code and raw HTML, where a hand-written label would show. */
function walkProse(node, visit) {
  if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return
  if (node.type === 'text') visit(node)
  for (const child of node.children ?? []) walkProse(child, visit)
}

/** A heading's rendered text, which is what GitHub slugs: code counts, raw HTML does not. */
function plainText(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value
  if (node.type === 'html') return ''
  return (node.children ?? []).map(plainText).join('')
}

function headingsOf(tree) {
  const out = []
  walk(tree, (n) => {
    if (n.type === 'heading') out.push(n)
  })
  return out
}

const decode = (path) => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function splitUrl(url) {
  const cut = url.search(/[?#]/)
  return cut === -1
    ? { path: url, suffix: '' }
    : { path: url.slice(0, cut), suffix: url.slice(cut) }
}

/**
 * The source range of a link, image or definition destination. mdast decodes
 * escapes and entities in `url`, so a caller rewrites only when the raw text
 * equals `url`; otherwise the replacement could not be byte-exact.
 */
function urlRange(src, node) {
  const start = node.position.start.offset
  const end = node.position.end.offset
  let i
  if (node.type === 'definition') {
    i = src.indexOf(']:', start)
  } else {
    const last = node.children?.at(-1)
    i = src.indexOf('](', last ? last.position.end.offset : start + (node.type === 'image' ? 2 : 1))
  }
  if (i === -1 || i >= end) return null
  i += 2
  while (i < end && /\s/.test(src[i])) i++
  if (src[i] === '<') {
    const close = src.indexOf('>', i)
    return close === -1 || close > end ? null : { start: i + 1, end: close }
  }
  let j = i
  let depth = 0
  while (j < end && !/\s/.test(src[j])) {
    if (src[j] === '\\') j++
    else if (src[j] === '(') depth++
    else if (src[j] === ')' && depth-- === 0) break
    j++
  }
  return { start: i, end: j }
}

/** Applies non-overlapping edits; insertions at one offset keep their order. */
function applyEdits(text, edits) {
  const sorted = edits.map((e, order) => ({ ...e, order }))
  sorted.sort((a, b) => a.start - b.start || a.order - b.order)
  let out = ''
  let pos = 0
  for (const e of sorted) {
    out += text.slice(pos, e.start) + e.text
    pos = e.end
  }
  return out + text.slice(pos)
}

/** A block inserted at a line start, with a blank line on each side. */
function padBlock(text, at, block) {
  let before = 0
  for (let i = at - 1; i >= 0 && text[i] === '\n' && before < 2; i--) before++
  const prefix = at === 0 ? '' : '\n'.repeat(2 - before)
  return prefix + block + (at >= text.length ? '\n' : '\n\n')
}

// ---------------------------------------------------------------------------
// Changeset files

function readChangesets(root, problems) {
  const dir = join(root, '.changeset')
  if (!existsSync(dir)) return []
  const pre = join(dir, 'pre')
  if (existsSync(pre) && statSync(pre).isDirectory()) {
    for (const name of readdirSync(pre).filter(isChangesetName).sort(cmp)) {
      problems.push(problem(`.changeset/pre/${name}`, null, 'pre mode is unsupported; remove it'))
    }
  }
  const records = []
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => isChangesetName(e.name))
    .sort((a, b) => cmp(a.name, b.name))
  for (const entry of entries) {
    const name = entry.name
    const file = `.changeset/${name}`
    if (!entry.isFile()) {
      problems.push(problem(file, null, 'is not a regular file; a changeset is a plain file'))
      continue
    }
    const slug = name.slice(0, -3)
    if (!isKebab(slug)) {
      problems.push(
        problem(file, null, 'the filename must be kebab-case: a-z, 0-9 and single dashes'),
      )
    }
    records.push(parseRecord(file, slug, readFileSync(join(dir, name), 'utf8'), problems))
  }
  return records
}

function parseMeta(node, lineOf, fail) {
  const meta = {}
  const value = node.value
  const close = value.indexOf('-->')
  if (close === -1) {
    fail(lineOf(node), 'the `<!-- migration` block never closes with `-->`')
    return meta
  }
  if (value.slice(close + 3).trim()) fail(lineOf(node), 'nothing may follow the closing `-->`')
  const lines = value.slice(value.indexOf('migration') + 'migration'.length, close).split('\n')
  lines.forEach((line, i) => {
    if (!line.trim()) return
    const lineNo = lineOf(node) + i
    const colon = line.indexOf(':')
    if (colon === -1) {
      fail(lineNo, `"${line.trim()}" is not a \`key: value\` line`)
      return
    }
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim()
    if (!META_KEYS.includes(key)) {
      fail(lineNo, `unknown key "${key}"; the keys are ${META_KEYS.join(', ')}`)
    } else if (Object.hasOwn(meta, key)) {
      fail(lineNo, `"${key}" is set twice`)
    } else if (!val) {
      fail(lineNo, `"${key}" has no value`)
    } else {
      meta[key] = val
    }
  })
  return meta
}

/**
 * Parses one changeset and applies the per-file rules. Its kind is `empty`
 * (no releases, no body), `legacy` (the owner of the frozen legacy section),
 * `entry`, or `part` (`extends` another entry). A record with an error is
 * `broken` and is left out of the assembled document.
 */
function parseRecord(file, slug, contents, problems) {
  const rec = { file, slug, kind: null, broken: false, releases: [], summary: '', meta: {} }
  rec.links = []
  rec.lineOf = () => null
  const fail = (line, message) => {
    problems.push(problem(file, line, message))
    rec.broken = true
  }
  let parsed
  try {
    parsed = parseChangesetFile(contents)
  } catch (err) {
    fail(null, `cannot be parsed: ${errorMessage(err).split('\n')[0]}`)
    return rec
  }
  rec.releases = parsed.releases
  rec.summary = parsed.summary
  for (const r of rec.releases) {
    if (r.type === 'major') fail(null, `"${r.name}": major is refused until 1.0`)
  }
  if (rec.releases.length === 0 && !rec.summary) {
    rec.kind = 'empty'
    return rec
  }
  if (rec.releases.length === 0) {
    fail(null, 'has a body but releases nothing; list the packages it changes, or empty the body')
    return rec
  }
  if (!rec.summary) {
    fail(null, 'releases packages but has an empty body; an empty changeset releases nothing')
    return rec
  }
  const lineBase = lineAt(contents, contents.indexOf(rec.summary)) - 1
  const lineOf = (node) => lineBase + node.position.start.line
  rec.lineOf = lineOf
  const tree = fromMarkdown(rec.summary)
  rec.tree = tree

  const metaNodes = tree.children.filter(
    (n) => n.type === 'html' && /^<!--\s*migration\b/.test(n.value),
  )
  if (metaNodes.length > 1) fail(lineOf(metaNodes[1]), 'has more than one `<!-- migration` block')
  rec.metaNode = metaNodes[0] ?? null
  if (rec.metaNode) rec.meta = parseMeta(rec.metaNode, lineOf, fail)
  const meta = rec.meta

  walkProse(tree, (node) => {
    const found = INT_LABEL_RE.exec(node.value) ?? NEXT_LABEL_RE.exec(node.value)
    if (found) {
      fail(
        lineOf(node),
        `hand-written label "${found[0]}"; labels come from the int tags, so leave them out`,
      )
    }
  })
  walk(tree, (n) => {
    if (n.type === 'link' || n.type === 'image') rec.links.push(n)
    if (n.type === 'definition') {
      // Spliced into one document, a definition would resolve every entry's `[label]`.
      fail(lineOf(n), `reference definition "[${n.label}]:" would be global; write the link inline`)
    }
    if (
      n.type === 'html' &&
      !n.value.trimStart().startsWith('<!--') &&
      /\b(?:href|src)\s*=/i.test(n.value)
    ) {
      fail(lineOf(n), 'raw HTML with href= or src= escapes link rebasing; use markdown links')
    }
  })
  const headings = headingsOf(tree)
  for (const h of headings) {
    if (h.depth <= 2) {
      fail(lineOf(h), `an H${h.depth} would end the changelog section; use ### for the title`)
    }
  }
  const h3s = headings.filter((h) => h.depth === 3)

  if (meta.legacy !== undefined) {
    rec.kind = 'legacy'
    if (meta.legacy !== 'true') fail(lineOf(rec.metaNode), '`legacy` takes only `true`')
    const others = Object.keys(meta).filter((k) => k !== 'legacy')
    if (others.length > 0)
      fail(lineOf(rec.metaNode), `the legacy owner takes no ${others.join(', ')}`)
    const extra = tree.children.find((n) => n !== rec.metaNode)
    if (extra) fail(lineOf(extra), 'the legacy owner holds only its `<!-- migration` block')
    for (const r of rec.releases) {
      if (r.type !== 'minor' && r.type !== 'patch') {
        fail(null, `"${r.name}": the legacy owner releases as minor or patch, not ${r.type}`)
      }
    }
    return rec
  }
  if (!rec.metaNode) {
    fail(null, 'needs a `<!-- migration` block with area, action and row')
    return rec
  }

  const hasPart = (label) =>
    tree.children.some(
      (n) =>
        n.type === 'paragraph' &&
        n.children[0]?.type === 'strong' &&
        plainText(n.children[0]).trim() === label,
    )
  const titleFirst = (h) => {
    if (h !== tree.children[0]) fail(lineOf(h), 'the ### title must come first in the body')
    walk(h, (n) => {
      if (['link', 'image', 'linkReference', 'imageReference'].includes(n.type)) {
        fail(lineOf(h), 'the ### title takes no links or images; it is embedded in links')
      }
    })
    rec.titleNode = h
    rec.titleText = plainText(h).trim()
  }
  const at = lineOf(rec.metaNode)

  if (!hasPart('What changed.')) fail(null, 'needs a **What changed.** paragraph')
  if (meta.action === undefined) {
    fail(at, 'needs `action`')
  } else {
    if (wordCount(meta.action) > MAX_ACTION_WORDS) {
      fail(at, `action "${meta.action}" is over ${MAX_ACTION_WORDS} words`)
    }
    for (const r of rec.releases) {
      if (r.type === 'major') continue
      if (NO_ACTION.has(meta.action)) {
        if (r.type !== 'patch' && r.type !== 'minor') {
          fail(
            null,
            `"${r.name}": an entry whose action is ${meta.action} releases as patch or minor`,
          )
        }
      } else if (r.type !== 'minor') {
        fail(
          null,
          `"${r.name}" is ${r.type}, but action "${meta.action}" asks adopters to act, so every release must be minor`,
        )
      }
    }
  }
  if (meta.area !== undefined && !AREAS.includes(meta.area)) {
    fail(at, `area "${meta.area}" is not one of ${AREAS.join(', ')}`)
  }
  if (meta.row !== undefined && wordCount(meta.row) > MAX_ROW_WORDS) {
    fail(at, `row "${meta.row}" is over ${MAX_ROW_WORDS} words`)
  }
  const rowMarkup = meta.row === undefined ? null : rowMarkupProblem(meta.row)
  if (rowMarkup) fail(at, `row "${meta.row}" ${rowMarkup}`)

  if (meta.extends === undefined) {
    rec.kind = 'entry'
    if (h3s.length !== 1) {
      fail(h3s[1] ? lineOf(h3s[1]) : null, `needs exactly one ### title, found ${h3s.length}`)
    } else {
      titleFirst(h3s[0])
    }
    for (const key of ['area', 'row']) if (meta[key] === undefined) fail(at, `needs \`${key}\``)
    if (meta.action !== undefined && !NO_ACTION.has(meta.action) && !hasPart('To adopt.')) {
      fail(null, `needs a **To adopt.** paragraph, since its action is "${meta.action}"`)
    }
    return rec
  }

  rec.kind = 'part'
  const target = /^(legacy|released)#(.+)$/.exec(meta.extends)
  if (target) {
    rec.target = { type: target[1], anchor: target[2] }
    if (h3s.length > 1) fail(lineOf(h3s[1]), 'a part takes at most one ### title')
    else if (h3s.length === 1) titleFirst(h3s[0])
  } else if (isKebab(meta.extends)) {
    rec.target = { type: 'slug', slug: meta.extends }
    if (h3s.length > 0) {
      fail(
        lineOf(h3s[0]),
        'a part of an unreleased entry has no ### title; it renders as "Added in"',
      )
    }
  } else {
    fail(
      at,
      `extends "${meta.extends}": expected a changeset slug, legacy#<anchor> or released#<anchor>`,
    )
  }
  return rec
}

// ---------------------------------------------------------------------------
// CHANGELOG.md

function sectionRange(tops, name) {
  const i = tops.findIndex(
    (n) => n.type === 'heading' && n.depth === 2 && plainText(n).trim() === name,
  )
  if (i === -1) return null
  const next = tops.findIndex((n, j) => j > i && n.type === 'heading' && n.depth <= 2)
  return { index: i, nextIndex: next === -1 ? tops.length : next }
}

function isDelimiterRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c))
}

const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')

/**
 * The parts of CHANGELOG.md the assembly needs: its headings with their
 * as-written anchors, the Unreleased and Released ranges, the first table in
 * Unreleased (parsed as CommonMark, a GFM table is a paragraph whose second
 * line is a delimiter row), and where the generated table and entries go.
 */
function readBase(root, problems) {
  const path = join(root, CHANGELOG)
  if (!existsSync(path)) {
    problems.push(problem(CHANGELOG, null, 'is missing'))
    return null
  }
  // micromark skips a byte-order mark, so its offsets index the text without one.
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const tree = fromMarkdown(text)
  const tops = tree.children
  const slugger = new GithubSlugger()
  const headings = headingsOf(tree).map((node) => {
    const h = {
      key: `base:${node.position.start.offset}`,
      depth: node.depth,
      text: plainText(node).trim(),
      offset: node.position.start.offset,
      origin: `${CHANGELOG}:${node.position.start.line}`,
    }
    h.rawAnchor = slugger.slug(h.text)
    return h
  })
  const unrel = sectionRange(tops, 'Unreleased')
  if (!unrel) {
    problems.push(problem(CHANGELOG, null, 'has no `## Unreleased` section'))
    return null
  }
  const range = ({ index, nextIndex }) => ({
    start: tops[index].position.end.offset,
    end: nextIndex < tops.length ? tops[nextIndex].position.start.offset : text.length,
  })
  const released = sectionRange(tops, 'Released')
  const base = { text, headings, links: [], unreleased: range(unrel) }
  base.released = released ? range(released) : null
  base.firstH2 = tops.find((n) => n.type === 'heading' && n.depth === 2).position.start.offset
  // Every relative link becomes absolute in the shipped copy, so each must be
  // rewritable; checking here makes --check refuse what --ship would.
  walk(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return
    const url = node.url
    if (!url || url.startsWith('#') || isAbsoluteUrl(url)) return
    const { path, suffix } = splitUrl(url)
    const repoPath = posix.normalize(path.replace(/^\/+/, '') || '.')
    const line = node.position.start.line
    const range = urlRange(text, node)
    if (repoPath === '..' || repoPath.startsWith('../')) {
      problems.push(problem(CHANGELOG, line, `link "${url}" leaves the repository`))
    } else if (!range || text.slice(range.start, range.end) !== url) {
      problems.push(problem(CHANGELOG, line, `write the link "${url}" without escapes`))
    } else {
      base.links.push({ range, repoPath, suffix, image: node.type === 'image' })
    }
  })

  const nodes = tops.slice(unrel.index + 1, unrel.nextIndex)
  let tableIdx = -1
  for (const [idx, node] of nodes.entries()) {
    walkProse(node, (t) => {
      const found = NEXT_LABEL_RE.exec(t.value)
      if (found) {
        problems.push(
          problem(
            CHANGELOG,
            t.position.start.line,
            `"${found[0]}" in Unreleased; labels come from the int tags`,
          ),
        )
      }
    })
    if (node.type !== 'paragraph') continue
    const lines = text.slice(node.position.start.offset, node.position.end.offset).split('\n')
    lines.forEach((line, i) => {
      if (/^ {0,3}\|/.test(line) && tableCells(line)[0]?.trim().toLowerCase() === 'next') {
        problems.push(
          problem(
            CHANGELOG,
            node.position.start.line + i,
            'a table row labelled `next` in Unreleased',
          ),
        )
      }
    })
    if (tableIdx !== -1) continue
    const header = lines.findIndex(
      (l, i) => /^ {0,3}\|/.test(l) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]),
    )
    if (header === -1) continue
    tableIdx = idx
    base.table = {
      end: node.position.end.offset,
      rows: lines.slice(header + 2).map((line) => {
        const cells = tableCells(line)
        const link = /\[([^\]]*)\]\(#([^)\s]+)\)/.exec(cells[2] ?? '')
        return { area: cells[1]?.trim(), text: link?.[1], anchor: link?.[2] }
      }),
    }
  }
  let lastH3 = -1
  nodes.forEach((n, i) => {
    if (n.type === 'heading' && n.depth === 3) lastH3 = i
  })
  const firstH3 = nodes.find((n) => n.type === 'heading' && n.depth === 3)
  const closing = nodes.find((n, i) => i > Math.max(lastH3, tableIdx) && n.type === 'thematicBreak')
  base.entriesAt = closing ? closing.position.start.offset : base.unreleased.end
  base.tableAt = firstH3 ? firstH3.position.start.offset : base.entriesAt
  return base
}

// ---------------------------------------------------------------------------
// git

function runGit(root, args, input) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Int tags, oldest N first. */
function parseIntTags(out) {
  return out
    .split('\n')
    .map((name) => ({ name, m: INT_TAG_RE.exec(name) }))
    .filter((t) => t.m)
    .map((t) => ({ name: t.name, n: Number(t.m[1]) }))
    .sort((a, b) => a.n - b.n || cmp(a.name, b.name))
}

/** `.changeset/` file name -> blob id, in a tag's tree. */
function lsTree(root, tag) {
  const out = runGit(root, ['ls-tree', '-z', `refs/tags/${tag}`, '--', '.changeset/'])
  const files = new Map()
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const [, type, blob] = entry.slice(0, tab).split(' ')
    const name = entry.slice(tab + 1).slice('.changeset/'.length)
    if (type === 'blob' && !name.includes('/') && isChangesetName(name)) files.set(name, blob)
  }
  return files
}

/** `.changeset/` names a commit anywhere in HEAD's history deleted (a rename counts). */
function deletedChangesets(root) {
  const out = runGit(root, [
    'log',
    '--no-renames',
    '--diff-filter=D',
    '--name-only',
    '--format=',
    'HEAD',
    '--',
    '.changeset/',
  ])
  return new Set(
    out
      .split('\n')
      .filter((p) => p.startsWith('.changeset/'))
      .map((p) => p.slice('.changeset/'.length)),
  )
}

/**
 * Tags and history. `usable` is false on a shallow clone or with no int tags,
 * and then nothing tag-dependent runs. M is the int tag nearest HEAD along its
 * first-parent chain, the largest N where one commit carries several: this
 * branch's own last int. A side branch's tag merged in is an ancestor too, but
 * what it shipped never shipped from here.
 */
function readGitState(root) {
  const state = { shallow: false, tags: [], usable: false, M: null }
  try {
    state.shallow = runGit(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true'
    state.tags = parseIntTags(runGit(root, ['tag', '--list', 'v*-int.*']))
  } catch {
    state.notRepo = true
    return state
  }
  state.usable = !state.shallow && state.tags.length > 0
  if (!state.usable) return state
  const byCommit = new Map()
  const tagged = new Map(state.tags.map((t) => [t.name, t]))
  const refs = runGit(root, [
    'for-each-ref',
    '--format=%(refname:strip=2) %(objectname) %(*objectname)',
    'refs/tags/',
  ])
  for (const line of refs.split('\n')) {
    const [name, object, peeled] = line.split(' ')
    const tag = tagged.get(name)
    if (!tag) continue
    const commit = peeled || object
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), tag])
  }
  for (const commit of runGit(root, ['rev-list', '--first-parent', 'HEAD']).split('\n')) {
    const here = byCommit.get(commit)
    if (here) {
      state.M = here.reduce((a, b) => (b.n > a.n ? b : a))
      break
    }
  }
  const trees = new Map()
  state.tree = (tag) => {
    if (!trees.has(tag.name)) trees.set(tag.name, lsTree(root, tag.name))
    return trees.get(tag.name)
  }
  state.isAncestor = (a, b) => {
    try {
      runGit(root, ['merge-base', '--is-ancestor', `refs/tags/${a.name}`, `refs/tags/${b.name}`])
      return true
    } catch (err) {
      if (err.status === 1) return false
      throw err
    }
  }
  return state
}

/** Blob ids of the working-tree changesets, as `git ls-tree` would report them once committed. */
function headBlobs(root, records) {
  if (records.length === 0) return new Map()
  const input = records.map((r) => join(root, r.file)).join('\n') + '\n'
  const ids = runGit(root, ['hash-object', '--stdin-paths'], input).trim().split('\n')
  return new Map(records.map((r, i) => [r.slug, ids[i]]))
}

/** The smallest N over all int tags, ancestors or not, whose tree carries the file. */
function computeLabels(records, git, fallback) {
  const labels = new Map()
  if (git.usable) {
    for (const tag of git.tags) {
      const tree = git.tree(tag)
      for (const r of records) {
        if (!labels.has(r.slug) && tree.has(`${r.slug}.md`)) labels.set(r.slug, String(tag.n))
      }
    }
  }
  for (const r of records) if (!labels.has(r.slug)) labels.set(r.slug, fallback)
  return labels
}

// ---------------------------------------------------------------------------
// Links

/**
 * Where a changeset-body URL points. Bodies are authored relative to
 * `.changeset/`, or to the repo root with a leading `/`: `./<slug>.md` is
 * another changeset, `../CHANGELOG.md#a` an anchor in the assembled document,
 * anything else relative a repo file.
 */
function resolveLink(url) {
  if (url === '' || isAbsoluteUrl(url)) return { kind: 'absolute' }
  if (url.startsWith('#')) return { kind: 'hash', anchor: url.slice(1) }
  const { path, suffix } = splitUrl(url)
  const repoPath = path.startsWith('/')
    ? posix.normalize(path.replace(/^\/+/, '') || '.')
    : posix.normalize(posix.join('.changeset', path))
  if (repoPath === '..' || repoPath.startsWith('../')) return { kind: 'escapes' }
  const name = repoPath.startsWith('.changeset/') ? repoPath.slice('.changeset/'.length) : ''
  if (!name.includes('/') && isChangesetName(name)) {
    return { kind: 'changeset', slug: name.slice(0, -3) }
  }
  if (repoPath === CHANGELOG && suffix.length > 1 && suffix.startsWith('#')) {
    return { kind: 'hash', anchor: suffix.slice(1) }
  }
  return { kind: 'file', repoPath, suffix }
}

/** A repo path at `sha` on GitHub: `raw` for an image, so it renders, `tree` for a directory. */
function fileUrl(root, sha, repoPath, image) {
  if (repoPath === '.') return `${REPO_URL}/tree/${sha}`
  let dir = false
  try {
    dir = statSync(join(root, decode(repoPath))).isDirectory()
  } catch {
    dir = false
  }
  return `${REPO_URL}/${dir ? 'tree' : image ? 'raw' : 'blob'}/${sha}/${repoPath}`
}

function rewriteBodyUrl(node, L, anchorOf) {
  const link = resolveLink(node.url)
  if (link.kind === 'changeset') {
    const anchor = anchorOf(`cs:${link.slug}`)
    return anchor === undefined ? null : `#${anchor}`
  }
  if (link.kind === 'hash') return node.url.startsWith('#') ? null : `#${link.anchor}`
  if (link.kind === 'file') {
    const image = node.type === 'image'
    return (
      (L.ship ? fileUrl(L.root, L.ship.sha, link.repoPath, image) : link.repoPath) + link.suffix
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Assembly

const firstIn = (label) =>
  label === 'next'
    ? '_Not yet in an int._'
    : /^\d+$/.test(label)
      ? `_First in int.${label}._`
      : `_First in ${label}._`
const addedIn = (label) =>
  label === 'next'
    ? 'Added, not yet in an int'
    : /^\d+$/.test(label)
      ? `Added in int.${label}`
      : `Added in ${label}`
const cell = (s) => s.replaceAll('|', '\\|')

/** A record's title and body, metadata removed and URLs rebased; everything else byte-identical. */
function renderRecord(rec, L, anchorOf) {
  const src = rec.summary
  const urlEdits = []
  for (const node of rec.links) {
    const url = rewriteBodyUrl(node, L, anchorOf)
    if (url === null) continue
    const range = urlRange(src, node)
    if (range && src.slice(range.start, range.end) === node.url) {
      urlEdits.push({ ...range, text: url })
    }
  }
  const t = rec.titleNode?.position
  const inTitle = (e) => t && e.start >= t.start.offset && e.end <= t.end.offset
  const cut = (node) => {
    if (!node) return null
    let end = node.position.end.offset
    while (end < src.length && /\s/.test(src[end])) end++
    return { start: node.position.start.offset, end, text: '' }
  }
  const title = t
    ? applyEdits(
        src.slice(t.start.offset, t.end.offset),
        urlEdits
          .filter(inTitle)
          .map((e) => ({ ...e, start: e.start - t.start.offset, end: e.end - t.start.offset })),
      )
    : null
  const bodyEdits = [cut(rec.titleNode), cut(rec.metaNode), ...urlEdits.filter((e) => !inTitle(e))]
  const body = applyEdits(src, bodyEdits.filter(Boolean)).trim()
  const bodyHeadings = headingsOf(rec.tree)
    .filter((h) => h !== rec.titleNode)
    .map((h) => ({ key: `body:${rec.slug}:${h.position.start.offset}`, text: plainText(h).trim() }))
    .map((h) => ({ ...h, origin: rec.file }))
  return { title, body, bodyHeadings }
}

/** The plain heading text an item shows: its own title, or "<parent>, continued". */
function itemTitle(rec) {
  return rec.titleNode ? rec.titleText : `${rec.parent.text}, continued`
}

function renderItem(rec, L, anchorOf) {
  const label = L.labels.get(rec.slug)
  const { title, body, bodyHeadings } = renderRecord(rec, L, anchorOf)
  const text = itemTitle(rec)
  const out = [title ?? `### ${escapeInline(text)}`, `<!-- changeset: ${rec.slug} -->`]
  out.push(firstIn(label))
  const headings = [{ key: `cs:${rec.slug}`, text, origin: rec.file }]
  if (rec.kind === 'part') {
    out.push(`Continues [${escapeInline(rec.parent.text)}](#${anchorOf(rec.parent.key)}).`)
  }
  out.push(body)
  headings.push(...bodyHeadings)
  for (const part of rec.parts ?? []) {
    const p = renderRecord(part, L, anchorOf)
    const heading = addedIn(L.labels.get(part.slug))
    out.push(`#### ${heading}`, `<!-- changeset: ${part.slug} -->`, p.body)
    headings.push({ key: `cs:${part.slug}`, text: heading, origin: part.file }, ...p.bodyHeadings)
  }
  return { text: out.join('\n\n'), headings }
}

function tableRow(rec, L, anchorOf) {
  const label = L.labels.get(rec.slug)
  const anchor = anchorOf(`cs:${rec.slug}`)
  if (rec.kind === 'entry') {
    const parts = [...new Set((rec.parts ?? []).map((p) => L.labels.get(p.slug)))]
    const later = parts.length > 0 ? ` (${parts.join(', ')})` : ''
    return `| ${label} | ${rec.meta.area} | [${cell(rec.meta.row)}](#${anchor})${later} | ${cell(rec.meta.action)} |`
  }
  return `| ${label} | ${rec.rowArea} | [${cell(rec.rowText)}](#${anchor}) | ${cell(rec.meta.action)} |`
}

/** Title links for the ship handoff lists; a nested part points at its "Added in" heading. */
function handoffItem(rec, anchorOf) {
  const text = rec.parentEntry ? `${rec.parentEntry.titleText}, continued` : itemTitle(rec)
  return `- [${escapeInline(text)}](#${anchorOf(`cs:${rec.slug}`)})`
}

function renderThisBuild(L, anchorOf) {
  const { version, sha, M, fresh, revised } = L.ship
  const headings = [{ key: 'build:this', text: 'This build', origin: 'This build' }]
  const lines = [
    '## This build',
    '',
    `Version \`${version}\`, built from [\`${sha.slice(0, 7)}\`](${REPO_URL}/tree/${sha}).`,
  ]
  if (M) {
    lines.push('', `### New since int.${M.n}`, '')
    headings.push({ key: 'build:new', text: `New since int.${M.n}`, origin: 'This build' })
    if (fresh.length > 0) lines.push(...fresh.map((r) => handoffItem(r, anchorOf)))
    else lines.push('No entries.')
    if (revised.length > 0) {
      lines.push(
        '',
        `### Revised since int.${M.n}`,
        '',
        ...revised.map((r) => handoffItem(r, anchorOf)),
      )
      headings.push({
        key: 'build:revised',
        text: `Revised since int.${M.n}`,
        origin: 'This build',
      })
    }
  } else {
    lines.push('', "No earlier int is in this build's history, so read every Unreleased entry.")
  }
  lines.push('', HANDOFF)
  return { text: lines.join('\n'), headings }
}

/**
 * Builds the document. `anchorOf(key)` supplies anchors, which come from the
 * returned heading model: the first pass runs with placeholders, and since no
 * anchor changes a heading's text, the second pass's headings are the same.
 */
function build(L, anchorOf) {
  const { base, items } = L
  const insertions = []
  const replacements = []
  if (L.ship) {
    const b = renderThisBuild(L, anchorOf)
    insertions.push({
      at: base.firstH2,
      text: padBlock(base.text, base.firstH2, b.text),
      headings: b.headings,
    })
  }
  const rows = items.map((rec) => tableRow(rec, L, anchorOf))
  if (rows.length > 0) {
    if (base.table) {
      insertions.push({ at: base.table.end, text: '\n' + rows.join('\n'), headings: [] })
    } else {
      const table = ['| int | Area | Change | Action |', '| --- | --- | --- | --- |', ...rows]
      insertions.push({
        at: base.tableAt,
        text: padBlock(base.text, base.tableAt, table.join('\n')),
        headings: [],
      })
    }
  }
  const blocks = items.map((rec) => renderItem(rec, L, anchorOf))
  if (blocks.length > 0) {
    insertions.push({
      at: base.entriesAt,
      text: padBlock(base.text, base.entriesAt, blocks.map((b) => b.text).join('\n\n')),
      headings: blocks.flatMap((b) => b.headings),
    })
  }
  if (L.ship) {
    for (const link of base.links) {
      const url = fileUrl(L.root, L.ship.sha, link.repoPath, link.image) + link.suffix
      replacements.push({ ...link.range, text: url })
    }
  }
  const text = applyEdits(base.text, [
    ...insertions.map((e) => ({ start: e.at, end: e.at, text: e.text })),
    ...replacements,
  ])
  const ordered = insertions.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at || a.i - b.i)
  const model = []
  let k = 0
  for (const h of base.headings) {
    while (k < ordered.length && ordered[k].at <= h.offset) model.push(...ordered[k++].headings)
    model.push(h)
  }
  while (k < ordered.length) model.push(...ordered[k++].headings)
  return { text, model }
}

/**
 * Everything the modes share: read, validate, label, assemble. `fallbackLabel`
 * labels a file no int tag carries; `ship` adds the This-build section and
 * absolute links.
 */
function analyze(root, { fallbackLabel, ship = null }) {
  const problems = []
  const notes = []
  const records = readChangesets(root, problems)
  const base = readBase(root, problems)
  const git = readGitState(root)
  const bySlug = new Map(records.map((r) => [r.slug, r]))
  const fail = (rec, message, line = null) => {
    problems.push(problem(rec.file, line, message))
    rec.broken = true
  }

  const owners = records.filter((r) => r.kind === 'legacy')
  for (const r of owners.slice(1)) {
    fail(r, `is a second legacy owner; ${owners[0].file} is one already`)
  }
  if (!base) return { problems, notes }

  const entries = records.filter((r) => r.kind === 'entry' && !r.broken)
  for (const e of entries) e.parts = []
  const continued = []
  for (const r of records.filter((x) => x.kind === 'part' && !x.broken)) {
    const t = r.target
    if (t.type === 'slug') {
      const parent = bySlug.get(t.slug)
      if (!parent) fail(r, `extends "${t.slug}", which is not a changeset`)
      else if (parent.kind === 'part') fail(r, `extends "${t.slug}", which is itself a part`)
      else if (parent.kind !== 'entry') fail(r, `extends "${t.slug}", which renders nothing`)
      else if (!parent.broken) {
        parent.parts.push(r)
        r.parentEntry = parent
      }
      continue
    }
    const section = t.type === 'legacy' ? base.unreleased : base.released
    const parent = base.headings.find(
      (h) =>
        section &&
        h.offset >= section.start &&
        h.offset < section.end &&
        h.rawAnchor === t.anchor &&
        (t.type === 'released' || h.depth === 3),
    )
    if (!parent) {
      const where = t.type === 'legacy' ? 'no ### in ## Unreleased' : 'no heading in ## Released'
      fail(r, `extends ${t.type}#${t.anchor}, but ${where} has that anchor`)
      continue
    }
    r.parent = parent
    const row = t.type === 'legacy' ? base.table?.rows.find((x) => x.anchor === t.anchor) : null
    r.rowArea = r.meta.area ?? row?.area
    r.rowText = r.meta.row ?? `${row?.text ?? escapeInline(parent.text)}, continued`
    if (r.rowArea) continued.push(r)
    else fail(r, 'needs `area`: its parent has no row in the Unreleased table to take one from')
  }

  const labels = computeLabels(records, git, fallbackLabel)
  const labelKey = (rec) => {
    const l = labels.get(rec.slug)
    return /^\d+$/.test(l) ? Number(l) : Infinity
  }
  const areaOf = (rec) => (rec.kind === 'entry' ? rec.meta.area : rec.rowArea)
  const items = [...entries, ...continued].sort(
    (a, b) => labelKey(a) - labelKey(b) || cmp(areaOf(a), areaOf(b)) || cmp(a.slug, b.slug),
  )
  for (const e of entries) e.parts.sort((a, b) => labelKey(a) - labelKey(b) || cmp(a.slug, b.slug))
  const shippable = items.flatMap((r) => [r, ...(r.parts ?? [])])

  if (!git.shallow && !git.notRepo) {
    const deleted = deletedChangesets(root)
    for (const r of records) {
      if (deleted.has(`${r.slug}.md`)) {
        fail(r, `the name "${r.slug}" was used before (history deletes ${r.file}); pick a new one`)
      }
    }
  }
  if (git.usable) {
    const heads = headBlobs(root, records)
    const mTree = git.M ? git.tree(git.M) : new Map()
    for (const r of records) {
      const name = `${r.slug}.md`
      if (mTree.has(name)) {
        if (mTree.get(name) !== heads.get(r.slug)) {
          problems.push(
            problem(
              r.file,
              null,
              `shipped in int.${git.M.n}; add an "extends" part unless this is a correction`,
              'warn',
            ),
          )
        }
        continue
      }
      // Reuse means the file left this branch's history: an int tag that is an
      // ancestor of M carried it, and M does not. A tag off to the side (a merged
      // or unmerged other branch) carrying it makes it new here, not reused.
      const earlier =
        git.M &&
        git.tags.find((tg) => tg !== git.M && git.tree(tg).has(name) && git.isAncestor(tg, git.M))
      if (earlier) {
        problems.push(
          problem(
            r.file,
            null,
            `reuses a slug: int.${earlier.n} carried it and int.${git.M.n} after it does not, so it was consumed or reverted; take a new slug`,
          ),
        )
      }
    }
    // A stable release consumes changesets and promote marks each in CHANGELOG.md;
    // any other way out of the tree loses an entry adopters were already told about.
    for (const name of mTree.keys()) {
      const slug = name.slice(0, -3)
      if (!bySlug.has(slug) && !base.text.includes(`<!-- changeset: ${slug} -->`)) {
        problems.push(
          problem(
            `.changeset/${name}`,
            null,
            `shipped in int.${git.M.n}; a shipped entry can't be removed or renamed, only corrected or extended`,
          ),
        )
      }
    }
    if (ship) {
      ship.M = git.M
      ship.fresh = shippable.filter((r) => !mTree.has(`${r.slug}.md`))
      ship.revised = shippable.filter(
        (r) => mTree.has(`${r.slug}.md`) && mTree.get(`${r.slug}.md`) !== heads.get(r.slug),
      )
    }
  } else {
    notes.push('tag-dependent checks skipped (no int tags / shallow)')
    if (ship) Object.assign(ship, { M: null, fresh: shippable, revised: [] })
  }

  const L = { root, base, items, labels, ship }
  const draft = build(L, () => 'pending')
  const slugger = new GithubSlugger()
  const anchors = new Map(draft.model.map((h) => [h.key, slugger.slug(h.text)]))
  const anchorSet = new Set(anchors.values())

  const bySlugBase = new Map()
  for (const h of draft.model) {
    const s = baseSlug(h.text)
    bySlugBase.set(s, [...(bySlugBase.get(s) ?? []), h])
    if (!h.key.startsWith('build:') && RESERVED_ANCHOR_RE.test(s)) {
      problems.push(
        problem(
          h.origin,
          null,
          `heading "${h.text}" takes an anchor the shipped This build section uses`,
        ),
      )
    }
  }
  // An inserted heading sharing a base heading's slug renumbers every later
  // copy, so a Released anchor adopters already link to would silently move.
  for (const h of base.headings) {
    const now = anchors.get(h.key)
    if (now === h.rawAnchor) continue
    const s = baseSlug(h.text)
    const culprits = draft.model.filter((m) => !m.key.startsWith('base:') && baseSlug(m.text) === s)
    const why = culprits.map((m) => `"${m.text}" (${m.origin})`).join(', ') || 'an inserted heading'
    problems.push(
      problem(
        culprits[0]?.origin ?? h.origin,
        null,
        `${why} moves "${h.text}" (${h.origin}) from #${h.rawAnchor} to #${now}; retitle it`,
      ),
    )
  }
  for (const rec of items) {
    const text = itemTitle(rec)
    const others = bySlugBase.get(baseSlug(text)).filter((h) => h.key !== `cs:${rec.slug}`)
    if (others.length > 0) {
      const list = others.map((h) => `"${h.text}" (${h.origin})`).join(', ')
      fail(
        rec,
        `the title "${text}" has the same anchor as ${list}; retitle it`,
        rec.titleNode ? rec.lineOf(rec.titleNode) : null,
      )
    }
  }

  for (const rec of shippable) {
    for (const node of rec.links) {
      const link = resolveLink(node.url)
      const line = rec.lineOf(node)
      const range = urlRange(rec.summary, node)
      const plain = range && rec.summary.slice(range.start, range.end) === node.url
      if (link.kind === 'escapes') {
        fail(rec, `link "${node.url}" leaves the repository`, line)
      } else if (link.kind === 'changeset') {
        const target = bySlug.get(link.slug)
        if (!target) fail(rec, `link "${node.url}": there is no .changeset/${link.slug}.md`, line)
        else if (!target.broken && !anchors.has(`cs:${link.slug}`)) {
          fail(rec, `link "${node.url}" points at a changeset that renders nothing`, line)
        }
      } else if (link.kind === 'hash' && !anchorSet.has(link.anchor)) {
        fail(
          rec,
          `link "${node.url}": no heading in the assembled ${CHANGELOG} has #${link.anchor}`,
          line,
        )
      } else if (link.kind === 'file' && !existsSync(join(root, decode(link.repoPath)))) {
        fail(rec, `link "${node.url}": ${link.repoPath} does not exist`, line)
      }
      if (
        link.kind !== 'absolute' &&
        !(link.kind === 'hash' && node.url.startsWith('#')) &&
        !plain
      ) {
        fail(rec, `write the link "${node.url}" without escapes, so it can be rebased`, line)
      }
    }
  }

  const final = build(L, (key) => anchors.get(key))
  const parsed = headingsOf(fromMarkdown(final.text)).map((h) => plainText(h).trim())
  const diverge = draft.model.findIndex((h, i) => parsed[i] !== h.text)
  if (diverge !== -1 || parsed.length !== draft.model.length) {
    const at = draft.model[diverge] ?? draft.model.at(-1)
    problems.push(
      problem(
        at.origin,
        null,
        `the assembled ${CHANGELOG} loses its headings from "${at.text}" on; a changeset probably leaves a code fence or HTML comment open`,
      ),
    )
  }
  return { problems, notes, text: final.text, ship }
}

// ---------------------------------------------------------------------------
// Modes

function check(root) {
  return analyze(root, { fallbackLabel: 'next' })
}

function thisBuildSummary(text) {
  const start = text.indexOf('## This build')
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end).trimEnd()
}

/** Writes the shipped CHANGELOG.md, failing closed on anything a check would refuse. */
function ship(root, { version, sha, out, summary }) {
  const v = parseVersion(version)
  const git = readGitState(root)
  const refuse = (message) => ({ problems: [problem(CHANGELOG, null, message)], notes: [] })
  if (git.notRepo) return refuse('--ship needs a git repository')
  if (git.shallow) return refuse('--ship refuses a shallow clone; check out with fetch-depth: 0')
  if (v.int !== null && git.tags.length === 0) {
    return refuse(`--ship of int version ${version} found no int tags; fetch them first`)
  }
  const result = analyze(root, {
    fallbackLabel: v.int !== null ? String(v.int) : version,
    ship: { version, sha },
  })
  if (result.problems.some((p) => p.severity === 'error')) return result
  writeFileSync(out, result.text)
  if (summary) {
    const fence = ['```sh', `node scripts/canopy-deps.mjs int ${version}`, '```'].join('\n')
    appendFileSync(summary, `\n${thisBuildSummary(result.text)}\n\n${fence}\n`)
  }
  return result
}

function parseVersion(v) {
  const dash = (v ?? '').indexOf('-')
  const core = dash === -1 ? (v ?? '') : v.slice(0, dash)
  const numbers = core.split('.')
  if (numbers.length !== 3 || !numbers.every((n) => /^(0|[1-9]\d*)$/.test(n))) return null
  if (dash !== -1) {
    for (const id of v.slice(dash + 1).split('.')) {
      if (!/^[0-9A-Za-z-]+$/.test(id) || /^0\d+$/.test(id)) return null
    }
  }
  const int = /-int\.(\d+)$/.exec(v)
  if (int && !/^[1-9]\d*$/.test(int[1])) return null
  return { int: int ? Number(int[1]) : null }
}

/** A relative output path resolves against the repo root and must stay inside it; an absolute one is taken as given. */
function resolveOutput(root, p) {
  if (isAbsolute(p)) return { path: p }
  const abs = resolve(root, p)
  const r = relative(root, abs)
  if (r === '' || r === '..' || r.startsWith('..' + sep) || isAbsolute(r)) {
    return { error: `${p} resolves outside the repository` }
  }
  return { path: abs }
}

const MODES = ['--check', '--preview', '--ship', '--self-test']
const VALUE_FLAGS = ['--version', '--sha', '--out', '--summary']
const USAGE =
  'usage: migration-notes.mjs --check | --preview | --self-test | --ship --version <v> --sha <40-hex> --out <path> [--summary <path>]'

/** Parses the command line, or returns `{ error }`. */
function parseArgs(argv, root) {
  let mode = null
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue // pnpm passes `pnpm <script> -- <args>` through verbatim
    if (MODES.includes(a)) {
      if (mode) return { error: `give one mode, not ${mode} and ${a}` }
      mode = a.slice(2)
    } else if (VALUE_FLAGS.includes(a)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${a} takes a value` }
      if (Object.hasOwn(opts, a.slice(2))) return { error: `${a} is given twice` }
      opts[a.slice(2)] = value
    } else {
      return { error: `unknown argument ${a}` }
    }
  }
  if (!mode) return { error: USAGE }
  if (mode !== 'ship') {
    return Object.keys(opts).length > 0
      ? { error: `--${Object.keys(opts)[0]} goes with --ship` }
      : { mode }
  }
  for (const key of ['version', 'sha', 'out'])
    if (!opts[key]) return { error: `--ship needs --${key}` }
  if (!parseVersion(opts.version))
    return { error: `--version ${opts.version} is not a semver version` }
  if (!/^[0-9a-f]{40}$/.test(opts.sha))
    return { error: '--sha takes a full 40-character lowercase hex SHA' }
  for (const key of ['out', 'summary']) {
    if (opts[key] === undefined) continue
    const r = resolveOutput(root, opts[key])
    if (r.error) return { error: `--${key}: ${r.error}` }
    opts[key] = r.path
  }
  return { mode, ...opts }
}

function report({ problems, notes }) {
  // stderr, so a --preview redirected to a file holds only the document.
  for (const n of notes) console.error(`note: ${n}`)
  for (const p of problems) {
    const loc = p.line != null ? `${p.file}:${p.line}` : p.file
    if (p.severity === 'warn') console.warn(`${loc} warning: ${p.message}`)
    else console.error(`${loc} ${p.message}`)
  }
  return problems.some((p) => p.severity === 'error') ? 1 : 0
}

// ---------------------------------------------------------------------------
// Self-test

function selfTest() {
  const failures = []
  const expect = (label, ok) => {
    if (!ok) failures.push(`  ${label}`)
  }
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  })
  const g = (dir, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const write = (dir, rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }

  const BASE = [
    '# Guide',
    '',
    'Intro.',
    '',
    '## How to use',
    '',
    'See the [readme](README.md#top), [root](/README.md) and ![logo](docs/logo.png).',
    '',
    '---',
    '',
    '## Unreleased',
    '',
    'Intro paragraph.',
    '',
    '| int | Area | Change | Action |',
    '| --- | --- | --- | --- |',
    '| 93 | Worker | [Legacy thing](#legacy-thing) | None |',
    '',
    '### Legacy thing',
    '',
    '**What changed.** Old.',
    '',
    '### Other legacy',
    '',
    'Body.',
    '',
    '---',
    '',
    '## Released',
    '',
    '### 0.0.67',
    '',
    '#### Released thing',
    '',
    'Body.',
    '',
  ].join('\n')
  const fm = (bump) => (bump ? `---\n"canopycms": ${bump}\n---\n\n` : '---\n---\n\n')
  const metaBlock = (m) =>
    [
      '<!-- migration',
      ...Object.entries(m)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}`),
      '-->',
    ].join('\n')
  const WHAT = '**What changed.** Something.'
  const ADOPT = '**To adopt.** Do it.'
  const entry = ({ bump = 'minor', title = 'A title', meta = {}, body = [WHAT, ADOPT] } = {}) =>
    fm(bump) +
    [
      title && `### ${title}`,
      metaBlock({ area: 'Worker', action: 'Required', row: 'A row', ...meta }),
      ...body,
    ]
      .filter(Boolean)
      .join('\n\n') +
    '\n'
  const part = (target, { bump = 'patch', title, meta = {}, body = [WHAT] } = {}) =>
    fm(bump) +
    [title && `### ${title}`, metaBlock({ extends: target, action: 'None', ...meta }), ...body]
      .filter(Boolean)
      .join('\n\n') +
    '\n'

  const tmp = mkdtempSync(join(tmpdir(), 'migration-notes-selftest-'))
  try {
    // A repo with no tags for the per-file rules; each case replaces .changeset/.
    const vrepo = join(tmp, 'v')
    mkdirSync(vrepo)
    g(vrepo, 'init', '-q')
    write(vrepo, 'README.md', '# Readme\n')
    write(vrepo, CHANGELOG, BASE)
    g(vrepo, 'add', '-A')
    g(vrepo, 'commit', '-qm', 'base')
    const run = (files, base = BASE) => {
      rmSync(join(vrepo, '.changeset'), { recursive: true, force: true })
      mkdirSync(join(vrepo, '.changeset'))
      write(vrepo, '.changeset/config.json', '{}\n')
      write(vrepo, '.changeset/README.md', '# Guide (int.5) (next)\n')
      for (const [name, content] of Object.entries(files)) {
        const path = join(vrepo, '.changeset', name)
        if (content === null) mkdirSync(path)
        else if (typeof content === 'object') symlinkSync(content.link, path)
        else write(vrepo, `.changeset/${name}`, content)
      }
      write(vrepo, CHANGELOG, base)
      const r = check(vrepo)
      const fmt = (p) => `${p.line != null ? `${p.file}:${p.line}` : p.file} ${p.message}`
      r.errors = r.problems.filter((p) => p.severity === 'error').map(fmt)
      r.warnings = r.problems.filter((p) => p.severity === 'warn').map(fmt)
      return r
    }
    const clean = (label, files, base) => {
      const r = run(files, base)
      expect(`${label}: expected no errors, got ${JSON.stringify(r.errors)}`, r.errors.length === 0)
      return r
    }
    const refused = (label, files, pattern, base) => {
      const r = run(files, base)
      expect(
        `${label}: expected an error matching ${pattern}, got ${JSON.stringify(r.errors)}`,
        r.errors.some((e) => pattern.test(e)),
      )
      return r
    }

    // kinds
    {
      const r = clean('kinds: an empty changeset', { 'empty-one.md': fm(null) })
      expect('kinds: an empty changeset renders nothing', r.text === BASE)
    }
    clean('kinds: a legacy owner', {
      'legacy-owner.md': fm('patch') + metaBlock({ legacy: 'true' }) + '\n',
    })
    refused(
      'kinds: a legacy owner with content',
      { 'legacy-owner.md': fm('minor') + metaBlock({ legacy: 'true' }) + '\n\nText.\n' },
      /legacy-owner\.md:\d+ the legacy owner holds only/,
    )
    refused(
      'kinds: two legacy owners',
      {
        'legacy-a.md': fm('minor') + metaBlock({ legacy: 'true' }) + '\n',
        'legacy-b.md': fm('minor') + metaBlock({ legacy: 'true' }) + '\n',
      },
      /legacy-b\.md is a second legacy owner/,
    )
    clean('kinds: a full entry', { 'an-entry.md': entry() })
    refused(
      'kinds: an entry without a title',
      { 'an-entry.md': entry({ title: '' }) },
      /exactly one ### title, found 0/,
    )
    refused(
      'kinds: an entry with two titles',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, '### Second'] }) },
      /exactly one ### title, found 2/,
    )
    refused('kinds: no What changed', { 'an-entry.md': entry({ body: [ADOPT] }) }, /What changed/)
    refused(
      'kinds: a Required entry without To adopt',
      { 'an-entry.md': entry({ body: [WHAT] }) },
      /To adopt/,
    )
    clean('kinds: a None entry without To adopt', {
      'an-entry.md': entry({ bump: 'patch', meta: { action: 'None' }, body: [WHAT] }),
    })
    refused(
      'kinds: an entry without row',
      { 'an-entry.md': entry({ meta: { row: undefined } }) },
      /needs `row`/,
    )
    refused(
      'kinds: an entry without area',
      { 'an-entry.md': entry({ meta: { area: undefined } }) },
      /needs `area`/,
    )
    refused(
      'kinds: an unknown key',
      { 'an-entry.md': entry({ meta: { colour: 'red' } }) },
      /an-entry\.md:\d+ unknown key "colour"/,
    )
    refused(
      'kinds: no metadata block',
      { 'an-entry.md': fm('minor') + `### T\n\n${WHAT}\n` },
      /needs a `<!-- migration` block/,
    )
    refused('kinds: releases with an empty body', { 'an-entry.md': fm('minor') }, /empty body/)
    refused(
      'kinds: a body without releases',
      { 'an-entry.md': fm(null) + 'Text.\n' },
      /releases nothing/,
    )
    refused(
      'kinds: an H2 in a body',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, '## Big'] }) },
      /an H2 would end/,
    )
    clean('kinds: a part of an unreleased entry', {
      'an-entry.md': entry(),
      'a-part.md': part('an-entry'),
    })
    refused(
      'kinds: a titled part of an unreleased entry',
      { 'an-entry.md': entry(), 'a-part.md': part('an-entry', { title: 'More' }) },
      /a-part\.md:\d+ a part of an unreleased entry has no ### title/,
    )
    refused(
      'kinds: a part of a part',
      { 'an-entry.md': entry(), 'a-part.md': part('an-entry'), 'b-part.md': part('a-part') },
      /b-part\.md extends "a-part", which is itself a part/,
    )
    refused(
      'kinds: a part of a missing slug',
      { 'a-part.md': part('nope') },
      /extends "nope", which is not a changeset/,
    )
    refused(
      'kinds: a part of a missing legacy anchor',
      { 'a-part.md': part('legacy#nope') },
      /no ### in ## Unreleased has that anchor/,
    )
    refused(
      'kinds: legacy# only names a ### in Unreleased',
      { 'a-part.md': part('legacy#released-thing', { meta: { area: 'Ops' } }) },
      /legacy#released-thing, but no ###/,
    )
    clean('kinds: a part of a released heading', {
      'a-part.md': part('released#released-thing', { meta: { area: 'Ops' } }),
    })
    refused(
      'kinds: a released part with no area',
      { 'a-part.md': part('released#released-thing') },
      /needs `area`: its parent has no row/,
    )
    refused(
      'kinds: a part without What changed',
      { 'a-part.md': part('legacy#legacy-thing', { body: ['Text.'] }) },
      /What changed/,
    )

    // bump
    refused(
      'bump: major',
      { 'an-entry.md': entry({ bump: 'major' }) },
      /major is refused until 1\.0/,
    )
    refused(
      'bump: patch for a Required action',
      { 'an-entry.md': entry({ bump: 'patch' }) },
      /is patch, but action "Required" asks adopters to act/,
    )
    clean('bump: patch for None', {
      'an-entry.md': entry({ bump: 'patch', meta: { action: 'None' } }),
    })
    clean('bump: minor for Optional', { 'an-entry.md': entry({ meta: { action: 'Optional' } }) })
    refused(
      'bump: none is not a release',
      { 'an-entry.md': entry({ bump: 'none', meta: { action: 'None' } }) },
      /releases as patch or minor/,
    )
    refused(
      'bump: the action match is case-sensitive',
      { 'an-entry.md': entry({ bump: 'patch', meta: { action: 'none' } }) },
      /must be minor/,
    )

    // area and caps
    refused(
      'area: outside the enum',
      { 'an-entry.md': entry({ meta: { area: 'Nope' } }) },
      /area "Nope" is not one of/,
    )
    clean('area: AI is an area', { 'an-entry.md': entry({ meta: { area: 'AI' } }) })
    refused(
      'caps: action over 5 words',
      { 'an-entry.md': entry({ meta: { action: 'a b c d e f' } }) },
      /over 5 words/,
    )
    refused(
      'caps: row over 10 words',
      { 'an-entry.md': entry({ meta: { row: 'a b c d e f g h i j k' } }) },
      /over 10 words/,
    )

    // labels
    for (const [what, text] of [
      ['(int.N)', 'Landed (int.112).'],
      ['int.N', 'Since int.5 it works.'],
      ['(next)', 'A later part (next).'],
      ['(next int)', 'A later part (next int).'],
    ]) {
      refused(
        `labels: ${what} in a body`,
        { 'an-entry.md': entry({ body: [WHAT, ADOPT, text] }) },
        /hand-written label/,
      )
    }
    clean('labels: prose about the next deploy, and a version', {
      'an-entry.md': entry({
        body: [WHAT, ADOPT, 'The next deploy picks up 0.0.68-int.101 and `int.7`.'],
      }),
    })
    refused(
      'labels: (next) in the Unreleased section',
      {},
      /CHANGELOG\.md:13 "\(next\)" in Unreleased/,
      BASE.replace('Intro paragraph.', 'Intro (next).'),
    )
    refused(
      'labels: a next row in the Unreleased table',
      {},
      /CHANGELOG\.md:18 a table row labelled `next`/,
      BASE.replace('| None |\n', '| None |\n| next | Ops | [X](#legacy-thing) | None |\n'),
    )
    clean(
      'labels: (next) in Released is history',
      {},
      BASE.replace('#### Released thing\n\nBody.', '#### Released thing\n\nBody (next).'),
    )

    // slug
    refused(
      'slug: not kebab-case',
      { 'Bad_Name.md': entry() },
      /Bad_Name\.md the filename must be kebab-case/,
    )

    // anchors
    refused(
      'anchors: a title colliding with a legacy heading',
      { 'an-entry.md': entry({ title: 'Legacy thing!' }) },
      /an-entry\.md:\d+ the title "Legacy thing!" has the same anchor as "Legacy thing" \(CHANGELOG\.md:19\)/,
    )
    refused(
      'anchors: two changesets with one title',
      { 'a-one.md': entry({ title: 'Same' }), 'b-two.md': entry({ title: 'Same' }) },
      /b-two\.md:\d+ the title "Same" has the same anchor as "Same" \(\.changeset\/a-one\.md\)/,
    )
    refused(
      'anchors: two default continued titles',
      { 'a-one.md': part('legacy#legacy-thing'), 'b-two.md': part('legacy#legacy-thing') },
      /same anchor as "Legacy thing, continued"/,
    )

    // links
    const linked = (link) => ({
      'an-entry.md': entry({ body: [WHAT, ADOPT, `See [x](${link}).`] }),
      'other-one.md': entry({ title: 'Other' }),
    })
    refused(
      'links: a missing changeset',
      linked('./missing.md'),
      /an-entry\.md:\d+ link "\.\/missing\.md": there is no \.changeset\/missing\.md/,
    )
    clean('links: an existing changeset, with a fragment', linked('./other-one.md#ignored'))
    refused(
      'links: a changeset that renders nothing',
      { ...linked('./empty-one.md'), 'empty-one.md': fm(null) },
      /renders nothing/,
    )
    refused(
      'links: a missing anchor via CHANGELOG.md',
      linked('../CHANGELOG.md#nope'),
      /no heading in the assembled CHANGELOG\.md has #nope/,
    )
    refused('links: a missing bare anchor', linked('#nope'), /has #nope/)
    clean('links: anchors in the assembled document', linked('../CHANGELOG.md#other'))
    clean('links: a bare legacy anchor', linked('#legacy-thing'))
    clean('links: an existing repo file', linked('../README.md#top'))
    refused('links: a missing repo file', linked('../nope.md'), /nope\.md does not exist/)
    refused('links: a link leaving the repository', linked('../../x.md'), /leaves the repository/)
    refused('links: an escaped destination', linked('../READ\\_ME.md'), /without escapes/)
    clean('links: a repo-root-relative file', linked('/README.md#top'))
    refused(
      'links: a missing repo-root-relative file',
      linked('/nope.md'),
      /nope\.md does not exist/,
    )
    clean('links: a protocol-relative URL is absolute', linked('//example.com/x'))
    refused(
      'links: a reference definition',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, 'See [x][d].', '[d]: ../README.md'] }) },
      /an-entry\.md:\d+ reference definition "\[d\]:" would be global/,
    )
    refused(
      'links: raw HTML with href=',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, 'See <a href="../README.md">it</a>.'] }) },
      /raw HTML with href= or src=/,
    )
    refused(
      'links: raw HTML with src=',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, '<img src="../logo.png">'] }) },
      /raw HTML with href= or src=/,
    )
    clean('links: an HTML comment mentioning href= is not a link', {
      'an-entry.md': entry({ body: [WHAT, ADOPT, '<!-- no href= here -->'] }),
    })
    refused(
      'links: a link in an entry title',
      { 'an-entry.md': entry({ title: 'See [x](../README.md)' }) },
      /the ### title takes no links or images/,
    )
    refused(
      'links: an image in a part title',
      { 'a-part.md': part('legacy#legacy-thing', { title: 'More ![i](/README.md)' }) },
      /the ### title takes no links or images/,
    )
    {
      const base = BASE.replace('### Other legacy', '### Other `x_y` legacy')
      const r = clean(
        'links: a parent title with markup is embedded as plain text',
        { 'a-part.md': part('legacy#other-x_y-legacy', { meta: { area: 'Ops' } }) },
        base,
      )
      expect(
        'links: Continues, the default title and its row use escaped plain text',
        r.text.includes('### Other x\\_y legacy, continued') &&
          r.text.includes('Continues [Other x\\_y legacy](#other-x_y-legacy).') &&
          r.text.includes(
            '| next | Ops | [Other x\\_y legacy, continued](#other-x_y-legacy-continued) | None |',
          ),
      )
    }

    // row markup
    refused(
      'row: an unescaped bracket',
      { 'an-entry.md': entry({ meta: { row: 'A [b] row' } }) },
      /has an unescaped `\[` or `\]`/,
    )
    refused(
      'row: a trailing backslash',
      { 'an-entry.md': entry({ meta: { row: 'A row \\' } }) },
      /ends in a lone/,
    )
    clean('row: escaped brackets', { 'an-entry.md': entry({ meta: { row: 'A \\[b\\] row' } }) })

    // listing, as @changesets/read@1.0.1 lists .changeset/
    refused(
      'listing: a file in .changeset/pre/',
      { 'pre/x.md': entry() },
      /\.changeset\/pre\/x\.md pre mode is unsupported/,
    )
    refused(
      'listing: a directory named like a changeset',
      { 'dir.md': null },
      /\.changeset\/dir\.md is not a regular file/,
    )
    refused(
      'listing: a symlink',
      { 'link.md': { link: '../README.md' } },
      /\.changeset\/link\.md is not a regular file/,
    )
    refused(
      'listing: agents.md in lower case is a changeset',
      { 'agents.md': 'junk\n' },
      /\.changeset\/agents\.md cannot be parsed/,
    )
    clean('listing: README.md is skipped in any case', {
      'ReadMe.md': 'junk\n',
      'AGENTS.md': 'junk\n',
    })

    // anchors stay put, and none takes the This build section's
    refused(
      'stability: a body heading renumbering a Released anchor',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, '#### 0.0.67'] }) },
      /moves "0\.0\.67" \(CHANGELOG\.md:31\) from #0067 to #0067-1/,
    )
    refused(
      'stability: a generated Added heading renumbering a Released anchor',
      { 'an-entry.md': entry(), 'a-part.md': part('an-entry') },
      /"Added, not yet in an int" \(\.changeset\/a-part\.md\) moves "Added, not yet in an int" \(CHANGELOG\.md:33\)/,
      BASE.replace('#### Released thing', '#### Added, not yet in an int'),
    )
    refused(
      'reserved: an entry titled This build',
      { 'an-entry.md': entry({ title: 'This build' }) },
      /heading "This build" takes an anchor the shipped This build section uses/,
    )
    refused(
      'reserved: a body heading This build',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, '#### This build'] }) },
      /an-entry\.md heading "This build" takes an anchor/,
    )
    refused(
      'reserved: a CHANGELOG.md heading',
      {},
      /CHANGELOG\.md:33 heading "Revised since int\.2" takes an anchor/,
      BASE.replace('#### Released thing', '#### Revised since int.2'),
    )
    refused(
      'reserved: --check validates CHANGELOG.md links',
      {},
      /CHANGELOG\.md:7 link "\.\.\/outside\.md" leaves the repository/,
      BASE.replace('README.md#top', '../outside.md'),
    )
    refused(
      'kinds: legacy# names a ### only, not a deeper heading in Unreleased',
      { 'a-part.md': part('legacy#sub-legacy', { meta: { area: 'Ops' } }) },
      /extends legacy#sub-legacy, but no ### in ## Unreleased has that anchor/,
      BASE.replace('**What changed.** Old.', '**What changed.** Old.\n\n#### Sub legacy'),
    )

    // assembly: placement, the table, parts, rebasing
    {
      const body = [
        WHAT,
        ADOPT,
        'Links: [r](../README.md#top), *keep  this*, [b](./other-one.md), [c](../CHANGELOG.md#legacy-thing),\n[x](https://example.com/a), [h](#legacy-thing) and ![i](/README.md).',
      ]
      const files = {
        'an-entry.md': entry({ body }),
        'other-one.md': entry({
          title: 'Other',
          meta: { area: 'Auth', action: 'None' },
          bump: 'patch',
          body: [WHAT],
        }),
        'an-entry-more.md': part('an-entry', { body: ['**What changed.** More.'] }),
        'legacy-more.md': part('legacy#legacy-thing', { body: ['**What changed.** Further.'] }),
      }
      const r = clean('assembly: a mixed set', files)
      const t = r.text
      expect(
        'assembly: rows append to the legacy table, sorted by area',
        t.includes(
          [
            '| 93 | Worker | [Legacy thing](#legacy-thing) | None |',
            '| next | Auth | [A row](#other) | None |',
            '| next | Worker | [A row](#a-title) (next) | Required |',
            '| next | Worker | [Legacy thing, continued](#legacy-thing-continued) | None |',
            '',
            '### Legacy thing',
          ].join('\n'),
        ),
      )
      expect(
        'assembly: an entry, its nested part and rebased links, byte-identical elsewhere',
        t.includes(
          [
            '### A title',
            '',
            '<!-- changeset: an-entry -->',
            '',
            '_Not yet in an int._',
            '',
            WHAT,
            '',
            ADOPT,
            '',
            'Links: [r](README.md#top), *keep  this*, [b](#other), [c](#legacy-thing),',
            '[x](https://example.com/a), [h](#legacy-thing) and ![i](README.md).',
            '',
            '#### Added, not yet in an int',
            '',
            '<!-- changeset: an-entry-more -->',
            '',
            '**What changed.** More.',
          ].join('\n'),
        ),
      )
      expect(
        'assembly: a legacy-parent part is its own entry',
        t.includes(
          [
            '### Legacy thing, continued',
            '',
            '<!-- changeset: legacy-more -->',
            '',
            '_Not yet in an int._',
            '',
            'Continues [Legacy thing](#legacy-thing).',
            '',
            '**What changed.** Further.',
            '',
            '---',
            '',
            '## Released',
          ].join('\n'),
        ),
      )
      const at = (s) => t.indexOf(s)
      expect(
        'assembly: entries follow the legacy entries in sorted order',
        at('Body.\n\n### Other\n') !== -1 &&
          at('### Other\n') < at('### A title') &&
          at('### A title') < at('### Legacy thing, continued'),
      )
      expect(
        'assembly: the rest of CHANGELOG.md is untouched',
        t.startsWith(BASE.slice(0, BASE.indexOf('| 93 |'))),
      )
    }
    {
      const noTable = BASE.replace(/\| int[^]*?None \|\n\n/, '')
      const r = clean('assembly: no table yet', { 'an-entry.md': entry() }, noTable)
      expect(
        'assembly: a table is created before the first ###',
        r.text.includes(
          'Intro paragraph.\n\n| int | Area | Change | Action |\n| --- | --- | --- | --- |\n| next | Worker | [A row](#a-title) | Required |\n\n### Legacy thing',
        ),
      )
    }
    refused(
      'assembly: an unclosed fence is caught',
      { 'an-entry.md': entry({ body: [WHAT, ADOPT, '```sh\nopen'] }) },
      /loses its headings from "Released" on/,
    )

    // git: labels, M, new/revised, reuse, shipped-and-changed
    const SHA = 'a'.repeat(40)
    const arepo = join(tmp, 'a')
    mkdirSync(arepo)
    g(arepo, 'init', '-q')
    write(arepo, 'README.md', '# Readme\n')
    write(arepo, CHANGELOG, BASE)
    const titled = (title, area = 'Worker') => entry({ title, meta: { area, row: `${title} row` } })
    write(arepo, '.changeset/alpha.md', titled('Alpha entry'))
    write(arepo, '.changeset/rev.md', titled('Rev entry', 'Ops'))
    g(arepo, 'add', '-A')
    g(arepo, 'commit', '-qm', 'c1')
    g(arepo, 'tag', 'v0.0.68-int.3')
    g(arepo, 'checkout', '-qb', 'side')
    write(arepo, '.changeset/beta.md', titled('Beta entry'))
    g(arepo, 'add', '-A')
    g(arepo, 'commit', '-qm', 'beta')
    g(arepo, 'tag', 'v0.0.68-int.4')
    g(arepo, 'checkout', '-qb', 'side2', 'v0.0.68-int.3')
    write(arepo, '.changeset/delta.md', titled('Delta entry'))
    g(arepo, 'add', '-A')
    g(arepo, 'commit', '-qm', 'delta')
    g(arepo, 'tag', 'v0.0.68-int.9')
    g(arepo, 'checkout', '-q', 'main')
    write(arepo, '.changeset/gamma.md', titled('Gamma entry'))
    g(arepo, 'add', '-A')
    g(arepo, 'commit', '-qm', 'gamma')
    g(arepo, 'tag', 'v0.0.68-int.6')
    g(arepo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    write(arepo, '.changeset/delta.md', titled('Delta entry'))
    write(arepo, '.changeset/rev.md', titled('Rev entry', 'Ops').replace('Do it.', 'Do it now.'))
    g(arepo, 'add', '-A')
    g(arepo, 'commit', '-qm', 'delta lands, rev revised')
    write(arepo, '.changeset/eps.md', titled('Eps entry'))
    {
      const r = check(arepo)
      const errors = r.problems.filter((p) => p.severity === 'error')
      const warns = r.problems.filter((p) => p.severity === 'warn')
      expect(
        `git: the merged side-branch entry is not a reuse, got ${JSON.stringify(errors)}`,
        errors.length === 0,
      )
      expect(
        'git: M is the nearest first-parent tag (int.6, not the unmerged int.9)',
        warns.length === 1 &&
          warns[0].file === '.changeset/rev.md' &&
          warns[0].message.startsWith('shipped in int.6;'),
      )
      expect('git: tag checks ran', r.notes.length === 0)
      const rows = [
        '| 3 | Ops | [Rev entry row]',
        '| 3 | Worker | [Alpha entry row]',
        '| 4 | Worker | [Beta entry row]',
        '| 6 | Worker | [Gamma entry row]',
        '| 9 | Worker | [Delta entry row]',
        '| next | Worker | [Eps entry row]',
      ]
      const at = rows.map((row) => r.text.indexOf(row))
      expect(
        `git: labels are the smallest N, an unmerged side tag included, got ${at}`,
        at.every((n, i) => n !== -1 && (i === 0 || n > at[i - 1])),
      )
      const out = join(tmp, 'ship-a.md')
      const summary = join(tmp, 'summary.md')
      writeFileSync(summary, 'EXISTING\n')
      const s = ship(arepo, { version: '0.0.68-int.10', sha: SHA, out, summary })
      expect(
        `ship: an int build ships, got ${JSON.stringify(s.problems.filter((p) => p.severity === 'error'))}`,
        existsSync(out),
      )
      const shipped = existsSync(out) ? readFileSync(out, 'utf8') : ''
      const section = shipped.slice(
        shipped.indexOf('## This build'),
        shipped.indexOf('## How to use'),
      )
      expect(
        'ship: New since M is a set difference, so the merged int.4 entry counts',
        section.includes(
          '### New since int.6\n\n- [Beta entry](#beta-entry)\n- [Delta entry](#delta-entry)\n- [Eps entry](#eps-entry)\n\n### Revised since int.6\n\n- [Rev entry](#rev-entry)\n',
        ),
      )
      expect(
        'ship: the section sits after the H1 block',
        shipped.startsWith(
          '# Guide\n\nIntro.\n\n## This build\n\nVersion `0.0.68-int.10`, built from [`aaaaaaa`](https://github.com/safeinsights/canopycms/tree/' +
            SHA +
            ').',
        ),
      )
      expect(
        'ship: an untagged entry takes this int',
        shipped.includes('| 10 | Worker | [Eps entry row](#eps-entry) | Required |') &&
          shipped.includes('_First in int.10._'),
      )
      expect(
        'ship: relative links in CHANGELOG.md become absolute',
        shipped.includes(
          `[readme](${REPO_URL}/blob/${SHA}/README.md#top), [root](${REPO_URL}/blob/${SHA}/README.md) and ![logo](${REPO_URL}/raw/${SHA}/docs/logo.png)`,
        ) && shipped.includes('[Legacy thing](#legacy-thing)'),
      )
      const sum = existsSync(summary) ? readFileSync(summary, 'utf8') : ''
      expect(
        'ship: --summary appends the section and the deps command',
        sum.startsWith('EXISTING\n\n## This build\n') &&
          sum.includes('### Revised since int.6') &&
          sum.endsWith('```sh\nnode scripts/canopy-deps.mjs int 0.0.68-int.10\n```\n'),
      )
    }
    {
      write(
        arepo,
        '.changeset/eps.md',
        entry({
          title: 'Eps entry',
          body: [WHAT, ADOPT, 'See [r](../README.md#top) and [b](./beta.md).'],
        }),
      )
      const out = join(tmp, 'ship-b.md')
      ship(arepo, { version: '0.0.68-int.10', sha: SHA, out })
      const shipped = existsSync(out) ? readFileSync(out, 'utf8') : ''
      expect(
        'ship: a rebased body link becomes absolute, a changeset link an anchor',
        shipped.includes(`See [r](${REPO_URL}/blob/${SHA}/README.md#top) and [b](#beta-entry).`),
      )
    }
    {
      const shallow = join(tmp, 'shallow')
      g(tmp, 'clone', '-q', '--depth', '1', `file://${arepo}`, shallow)
      const r = check(shallow)
      expect(
        'git: a shallow clone skips the tag checks',
        r.notes.includes('tag-dependent checks skipped (no int tags / shallow)'),
      )
      const s = ship(shallow, { version: '0.0.68-int.10', sha: SHA, out: join(tmp, 'x.md') })
      expect(
        'ship: a shallow clone fails closed',
        s.problems.some((p) => /shallow/.test(p.message)) && !existsSync(join(tmp, 'x.md')),
      )
    }
    {
      const r = run({ 'an-entry.md': entry() })
      expect(
        'git: no int tags skips the tag checks and passes',
        r.errors.length === 0 &&
          r.notes.includes('tag-dependent checks skipped (no int tags / shallow)'),
      )
      const s = ship(vrepo, { version: '0.0.68-int.10', sha: SHA, out: join(tmp, 'y.md') })
      expect(
        'ship: an int build with no int tags fails closed',
        s.problems.some((p) => /no int tags/.test(p.message)) && !existsSync(join(tmp, 'y.md')),
      )
      const stable = join(tmp, 'stable.md')
      ship(vrepo, { version: '0.1.0', sha: SHA, out: stable })
      const text = existsSync(stable) ? readFileSync(stable, 'utf8') : ''
      expect(
        'ship: a stable build with no int tags labels with its version',
        text.includes('| 0.1.0 | Worker | [A row](#a-title) | Required |') &&
          text.includes('_First in 0.1.0._') &&
          text.includes("No earlier int is in this build's history"),
      )
      run({ 'an-entry.md': entry({ title: 'Legacy thing!' }) })
      const bad = join(tmp, 'bad.md')
      const b = ship(vrepo, { version: '0.1.0', sha: SHA, out: bad })
      expect(
        'ship: a failing check fails closed',
        b.problems.some((p) => /same anchor/.test(p.message)) && !existsSync(bad),
      )
    }
    {
      const rrepo = join(tmp, 'r')
      mkdirSync(rrepo)
      g(rrepo, 'init', '-q')
      write(rrepo, CHANGELOG, BASE)
      write(rrepo, '.changeset/zeta.md', entry())
      g(rrepo, 'add', '-A')
      g(rrepo, 'commit', '-qm', 'zeta')
      g(rrepo, 'tag', 'v0.0.1-int.1')
      g(rrepo, 'rm', '-q', '.changeset/zeta.md')
      g(rrepo, 'commit', '-qm', 'consume')
      g(rrepo, 'tag', 'v0.0.1-int.2')
      write(rrepo, '.changeset/zeta.md', entry())
      const r = check(rrepo)
      expect(
        'git: a consumed slug is refused on reuse',
        r.problems.some(
          (p) =>
            p.file === '.changeset/zeta.md' &&
            /^reuses a slug: int\.1 carried it and int\.2/.test(p.message),
        ),
      )
    }

    {
      // The reviewer's case: b (int.110) merges c (int.115), adds bee-two, ships int.120.
      const brepo = join(tmp, 'b')
      mkdirSync(brepo)
      g(brepo, 'init', '-q')
      write(brepo, 'README.md', '# Readme\n')
      write(brepo, CHANGELOG, BASE)
      g(brepo, 'add', '-A')
      g(brepo, 'commit', '-qm', 'base')
      g(brepo, 'checkout', '-qb', 'c')
      write(brepo, '.changeset/cee-one.md', titled('Cee one'))
      g(brepo, 'add', '-A')
      g(brepo, 'commit', '-qm', 'cee-one')
      g(brepo, 'tag', 'v0.0.68-int.115')
      g(brepo, 'checkout', '-q', 'main')
      write(brepo, '.changeset/bee-one.md', titled('Bee one'))
      g(brepo, 'add', '-A')
      g(brepo, 'commit', '-qm', 'bee-one')
      g(brepo, 'tag', 'v0.0.68-int.110')
      g(brepo, 'merge', '-q', '--no-ff', '-m', 'merge c', 'c')
      write(brepo, '.changeset/bee-two.md', titled('Bee two'))
      g(brepo, 'add', '-A')
      g(brepo, 'commit', '-qm', 'bee-two')
      const out = join(tmp, 'ship-firstparent.md')
      const s = ship(brepo, { version: '0.0.68-int.120', sha: SHA, out })
      const shipped = existsSync(out) ? readFileSync(out, 'utf8') : ''
      const section = shipped.slice(
        shipped.indexOf('## This build'),
        shipped.indexOf('## How to use'),
      )
      expect(
        `git: M is int.110 along the first-parent chain, not the merged int.115, got ${JSON.stringify(s.problems)}`,
        section.includes(
          '### New since int.110\n\n- [Cee one](#cee-one)\n- [Bee two](#bee-two)\n\n',
        ) && !section.includes('Bee one'),
      )
      write(brepo, '.changeset/bee-three.md', titled('Bee `three_x`'))
      const out2 = join(tmp, 'ship-escaped.md')
      ship(brepo, { version: '0.0.68-int.120', sha: SHA, out: out2 })
      const escaped = existsSync(out2) ? readFileSync(out2, 'utf8') : ''
      expect(
        'links: the New list embeds escaped plain titles',
        escaped.includes('- [Bee three\\_x](#bee-three_x)'),
      )
    }
    {
      const drepo = join(tmp, 'd')
      mkdirSync(drepo)
      g(drepo, 'init', '-q')
      write(drepo, CHANGELOG, BASE)
      write(drepo, '.changeset/gone.md', entry({ title: 'Gone' }))
      write(drepo, '.changeset/kept.md', entry({ title: 'Kept' }))
      g(drepo, 'add', '-A')
      g(drepo, 'commit', '-qm', 'two')
      g(drepo, 'rm', '-q', '.changeset/gone.md')
      g(drepo, 'mv', '.changeset/kept.md', '.changeset/moved.md')
      g(drepo, 'commit', '-qm', 'consume one, rename one')
      write(drepo, '.changeset/gone.md', entry({ title: 'Gone' }))
      const r = check(drepo)
      expect(
        'git: a name deleted in history is refused without any tag',
        r.problems.some(
          (p) =>
            p.file === '.changeset/gone.md' && /^the name "gone" was used before/.test(p.message),
        ),
      )
      expect(
        'git: a renamed file keeps its new name',
        !r.problems.some((p) => p.file === '.changeset/moved.md'),
      )
    }
    {
      const srepo = join(tmp, 's')
      mkdirSync(srepo)
      g(srepo, 'init', '-q')
      write(srepo, CHANGELOG, BASE)
      write(srepo, '.changeset/shipped-one.md', entry({ title: 'Shipped' }))
      g(srepo, 'add', '-A')
      g(srepo, 'commit', '-qm', 'shipped')
      g(srepo, 'tag', 'v0.0.1-int.1')
      g(srepo, 'mv', '.changeset/shipped-one.md', '.changeset/renamed-one.md')
      g(srepo, 'commit', '-qm', 'rename')
      const shipped = /shipped in int\.1; a shipped entry can't be removed or renamed/
      const r = check(srepo)
      expect(
        'git: renaming a shipped changeset is refused',
        r.problems.some((p) => p.file === '.changeset/shipped-one.md' && shipped.test(p.message)),
      )
      write(srepo, CHANGELOG, BASE + '\n<!-- changeset: shipped-one -->\n')
      expect(
        'git: a promoted changeset may leave the tree',
        !check(srepo).problems.some((p) => shipped.test(p.message)),
      )
    }

    // args
    const ok = (argv) => parseArgs(argv, tmp)
    expect('args: --check', ok(['--check']).mode === 'check')
    expect('args: two modes', ok(['--check', '--preview']).error)
    expect('args: an unknown flag', ok(['--check', '--bogus']).error)
    expect('args: --version goes with --ship', ok(['--check', '--version', '0.1.0']).error)
    const shipArgs = [
      '--ship',
      '--version',
      '0.0.68-int.10',
      '--sha',
      SHA,
      '--out',
      'pkg/CHANGELOG.md',
    ]
    expect('args: a full --ship', ok(shipArgs).out === join(tmp, 'pkg', 'CHANGELOG.md'))
    expect('args: --ship needs --out', ok(shipArgs.slice(0, 5)).error)
    expect('args: a short sha', ok(shipArgs.with(4, 'abc')).error)
    for (const bad of ['0.0.68-int.0', '01.0.0', '1.0', '1.0.0-', '1.0.0-a..b']) {
      expect(`args: version ${bad} is refused`, ok(shipArgs.with(2, bad)).error)
    }
    expect('args: --out may not leave the repo', ok(shipArgs.with(6, '../x.md')).error)
    expect(
      'args: an absolute --summary is taken as given',
      ok([...shipArgs, '--summary', '/tmp/s.md']).summary === '/tmp/s.md',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error('migration-notes self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.info('migration-notes self-test passed.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI

const args = parseArgs(process.argv.slice(2), repoRoot)
if (args.error) {
  console.error(args.error)
  process.exit(1)
}
if (args.mode === 'self-test') selfTest()
if (args.mode === 'check') {
  const result = check(repoRoot)
  const code = report(result)
  if (code === 0) console.info('changesets pass')
  process.exit(code)
}
if (args.mode === 'preview') {
  const result = check(repoRoot)
  if (result.text) process.stdout.write(result.text)
  process.exit(report(result))
}
const result = ship(repoRoot, args)
const code = report(result)
if (code === 0) console.info(`wrote ${args.out}`)
process.exit(code)
