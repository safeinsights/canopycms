#!/usr/bin/env node
// Proves a git range changed only comments in TypeScript files.
//
// Diffs `<git-range>` (A..B, A...B, or a single ref A meaning A..HEAD),
// requires every changed .ts/.tsx/.mts/.cts file to be a plain modification
// (not added/deleted/renamed/copied/type-changed), then compares each side's
// token stream via the TypeScript compiler's own parser: every leaf node
// (identifiers, punctuation, literals, JSX text) must match, in order, and
// every directive comment (`// eslint-disable...`, `/// <reference .../>`,
// etc.) and JSDoc tag (`@internal`, `@deprecated`, ...) must be unchanged too,
// since those affect behavior even though they are spelled as comments.
//
// Git runs in the caller's cwd (not this repo), so this also works against a
// throwaway git repository for self-testing.

import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const STATUS_NAMES = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' }

/** Directive comments change what surrounding tooling does, not just prose. */
const DIRECTIVE_COMMENT_RE =
  /^\/\/\/\s*<reference|^(?:\/\/|\/\*)\s*(?:eslint-|@ts-|v8 ignore|@vitest-environment|prettier-ignore|@jsx)/
const JSDOC_TAG_RE = /@(?:internal|deprecated|public|packageDocumentation)\b/g

const rangeArg = process.argv[2]
if (!rangeArg) {
  console.error('Usage: node scripts/diff-comments-only.mjs <git-range>')
  console.error('  <git-range> is A..B, A...B, or a single ref A (meaning A..HEAD)')
  process.exit(2)
}

const cwd = process.cwd()
const MAX_BUFFER = 64 * 1024 * 1024

function git(args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

function resolveRange(arg) {
  if (arg.includes('...')) {
    const [left, right] = arg.split('...')
    return { base: git(['merge-base', left, right]).trim(), head: right }
  }
  if (arg.includes('..')) {
    const [left, right] = arg.split('..')
    return { base: left, head: right }
  }
  return { base: arg, head: 'HEAD' }
}

function isTsPath(p) {
  return TS_EXTENSIONS.some((ext) => p.endsWith(ext))
}

/** { status, path } for a plain change, or { status, oldPath, newPath } for a rename/copy. */
function parseNameStatusLine(line) {
  const parts = line.split('\t')
  const letter = parts[0][0]
  if (letter === 'R' || letter === 'C') {
    return { status: letter, oldPath: parts[1], newPath: parts[2] }
  }
  return { status: letter, path: parts[1] }
}

/** Skips JSDoc and empty-`{/* *\/}` subtrees; records every real leaf as a token. */
function collectLeaves(sourceFile) {
  const leaves = []
  const commentNodes = []

  function visit(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return
    if (node.kind === ts.SyntaxKind.JsxExpression && node.expression === undefined) return
    const children = node.getChildren(sourceFile)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    commentNodes.push(node)
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return
    let text = node.getText(sourceFile)
    if (node.kind === ts.SyntaxKind.JsxText) {
      text = text.replace(/\s+/g, ' ').trim()
      if (text === '') return
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    leaves.push({ kind: ts.SyntaxKind[node.kind], text, line: line + 1 })
  }

  visit(sourceFile)
  return { leaves, commentNodes }
}

/** Directive comments (with line) and JSDoc tag words (bare), deduped by source position. */
function collectDirectivesAndTags(text, sourceFile, commentNodes) {
  const directives = []
  const tags = []
  const seenPos = new Set()
  for (const node of commentNodes) {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ]
    for (const range of ranges) {
      if (seenPos.has(range.pos)) continue
      seenPos.add(range.pos)
      const collapsed = text.slice(range.pos, range.end).replace(/\s+/g, ' ').trim()
      if (DIRECTIVE_COMMENT_RE.test(collapsed)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos)
        directives.push({ text: collapsed, line: line + 1 })
      }
      for (const m of collapsed.matchAll(JSDOC_TAG_RE)) tags.push(m[0])
    }
  }
  return { directives, tags }
}

function firstDiffIndex(a, b, eq) {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (i >= a.length || i >= b.length || !eq(a[i], b[i])) return i
  }
  return -1
}

function checkDirectives(file, baseD, headD, failures) {
  const idx = firstDiffIndex(baseD, headD, (a, b) => a.text === b.text)
  if (idx === -1) return
  const b = baseD[idx]
  const h = headD[idx]
  if (!b) failures.push(`FAIL: ${file}: directive added: head line ${h.line} \`${h.text}\``)
  else if (!h) failures.push(`FAIL: ${file}: directive removed: base line ${b.line} \`${b.text}\``)
  else
    failures.push(
      `FAIL: ${file}: directive changed: base line ${b.line} \`${b.text}\` vs head line ${h.line} \`${h.text}\``,
    )
}

function checkTags(file, baseT, headT, failures) {
  const idx = firstDiffIndex(baseT, headT, (a, b) => a === b)
  if (idx === -1) return
  failures.push(
    `FAIL: ${file}: JSDoc tag changed: base has [${baseT.join(', ')}] vs head has [${headT.join(', ')}]`,
  )
}

function checkTokens(file, baseLeaves, headLeaves, failures) {
  const idx = firstDiffIndex(
    baseLeaves,
    headLeaves,
    (a, b) => a.kind === b.kind && a.text === b.text,
  )
  if (idx === -1) return
  const b = baseLeaves[idx]
  const h = headLeaves[idx]
  if (!b || !h) {
    failures.push(
      `FAIL: ${file}: token ${idx} differs: base has ${baseLeaves.length} tokens, head has ${headLeaves.length}`,
    )
    return
  }
  failures.push(
    `FAIL: ${file}: token ${idx} differs: base line ${b.line} \`${b.text}\` (${b.kind}) vs head line ${h.line} \`${h.text}\` (${h.kind})`,
  )
}

const { base, head } = resolveRange(rangeArg)
const nameStatus = git(['diff', '--name-status', '-M', base, head])
  .split('\n')
  .filter(Boolean)
  .map(parseNameStatusLine)

const toCompare = []
const notTypeScript = []
const failures = []
const failedFiles = new Set()

for (const entry of nameStatus) {
  const isRename = entry.status === 'R' || entry.status === 'C'
  const paths = isRename ? [entry.oldPath, entry.newPath] : [entry.path]
  if (!paths.some(isTsPath)) {
    notTypeScript.push(isRename ? `${entry.oldPath} -> ${entry.newPath}` : entry.path)
    continue
  }
  if (entry.status !== 'M') {
    const name = isRename ? entry.newPath : entry.path
    const statusWord = STATUS_NAMES[entry.status] ?? entry.status
    failures.push(
      `FAIL: ${name}: ${statusWord} -- added/deleted/renamed files are not comment-only`,
    )
    failedFiles.add(name)
    continue
  }
  toCompare.push(entry.path)
}

for (const path of toCompare) {
  const baseText = git(['show', `${base}:${path}`])
  const headText = git(['show', `${head}:${path}`])
  const scriptKind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const baseSF = ts.createSourceFile(path, baseText, ts.ScriptTarget.Latest, true, scriptKind)
  const headSF = ts.createSourceFile(path, headText, ts.ScriptTarget.Latest, true, scriptKind)
  const baseWalk = collectLeaves(baseSF)
  const headWalk = collectLeaves(headSF)
  const baseDT = collectDirectivesAndTags(baseText, baseSF, baseWalk.commentNodes)
  const headDT = collectDirectivesAndTags(headText, headSF, headWalk.commentNodes)

  const before = failures.length
  checkDirectives(path, baseDT.directives, headDT.directives, failures)
  checkTags(path, baseDT.tags, headDT.tags, failures)
  checkTokens(path, baseWalk.leaves, headWalk.leaves, failures)
  if (failures.length > before) failedFiles.add(path)
}

for (const line of failures) console.log(line)
if (failures.length > 0) {
  console.log(`FAIL: ${failedFiles.size} file(s) differ beyond comments`)
} else {
  console.log(
    `PASS: comment-only change across ${rangeArg} (${toCompare.length} TypeScript file(s) compared)`,
  )
}
if (notTypeScript.length > 0) {
  console.log('not checked (not TypeScript):')
  for (const p of [...notTypeScript].sort()) console.log(`  ${p}`)
}

process.exit(failures.length > 0 ? 1 : 0)
