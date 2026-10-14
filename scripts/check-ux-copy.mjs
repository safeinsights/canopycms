#!/usr/bin/env node
/**
 * Copy rules for the editor UI (docs/ux-guidelines.md), ratcheted per file against
 * scripts/ux-copy-baseline.json. Parses every non-test, non-story source file under
 * packages/canopycms/src/editor and, transitively, each src/ file the editor loads through a value
 * import or re-export (type-only ones skipped), since its copy can live outside editor/
 * (api/entries-constants.ts). Checks the
 * text a user can read: string literals, template text and JSX text, skipping module
 * specifiers, literal and template-literal types, and console.* arguments. Three rules:
 * - `ellipsis`: three ASCII dots where `…` is meant, outside a route's `/...rest` parameter.
 * - `successfully`: the word, in any casing. A result reads as done without it.
 * - `title-case`: a label or placeholder in Title Case: the text of a button-like
 *   or menu element (LABEL_ELEMENTS), or a LABEL_KEYS attribute or object-literal
 *   property (`placeholder` included). Sentence case allows a capital only on
 *   the first word of each phrase (phrases break after . ! ? : and at · | — –),
 *   on proper nouns (PROPER_NOUNS, all-caps words, and words with a capital
 *   after their first letter, like GitHub) and inside double quotes, which
 *   hold a name rather than copy. A false positive is fixed by adding its
 *   proper noun to PROPER_NOUNS.
 *
 * The baseline holds each file's count per rule. A count above its baseline fails and lists
 * that file's findings for the rule; a count below it fails too, until `--write-baseline`
 * records the improvement, so a recorded fix leaves no room for a later violation; a fix and a
 * new violation in one file in one change still net out. A rewrite that would raise a count is
 * refused without `--allow-raise`.
 *
 *   node scripts/check-ux-copy.mjs                    # check against the baseline
 *   node scripts/check-ux-copy.mjs --report           # list every finding
 *   node scripts/check-ux-copy.mjs --write-baseline [--allow-raise]
 *   node scripts/check-ux-copy.mjs --self-test        # check the classifier
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_ROOT = join(repoRoot, 'packages/canopycms/src')
const SCOPE = join(SRC_ROOT, 'editor')
const baselinePath = join(repoRoot, 'scripts', 'ux-copy-baseline.json')
const rel = (p) => relative(repoRoot, p).split(sep).join('/')

const EXCLUDED_DIRS = new Set(['__test__', '__tests__', '__fixtures__', 'node_modules'])
const EXCLUDED_BASENAME = /\.(test|stories)\.tsx?$|\.d\.ts$/

const LABEL_ELEMENTS = new Set([
  'ActionIcon',
  'Anchor',
  'Button',
  'Chip',
  'DestructiveMenuItem',
  'Drawer.Title',
  'Menu.Item',
  'Menu.Label',
  'Modal.Title',
  'NavLink',
  'ReasonedMenuItem',
  'Tabs.Tab',
  'Title',
  'UnstyledButton',
  'button',
])
const LABEL_KEYS = new Set([
  'aria-label',
  'cancel',
  'cancelLabel',
  'confirm',
  'confirmLabel',
  'label',
  'placeholder',
  'title',
])
const PROPER_NOUNS = new Set([
  'Canopy',
  'Chrome',
  'Clerk',
  'Firefox',
  'Git',
  'Markdown',
  'Mermaid',
  'Safari',
  'Windows',
])

/** A placeholder for an interpolated value: it holds a word position but is never flagged. */
const SLOT = '\uE000'
const PHRASE_BREAK_TOKEN = /^[·|—–]$/
const PHRASE_END = /[.!?:]["')\]]*$/

/** The Title Case words in `text`, or [] when it is sentence case. */
function titleCaseWords(text) {
  const flagged = []
  let position = 0
  let quoted = false
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (PHRASE_BREAK_TOKEN.test(token)) {
      position = 0
      continue
    }
    const opensQuote = !quoted && /^[^\p{L}\p{N}]*["“]/u.test(token)
    if (opensQuote) quoted = true
    const word = token.replace(/^[^\p{L}\p{N}\uE000]+|[^\p{L}\p{N}\uE000]+$/gu, '')
    const inQuote = quoted
    if (quoted && /["”][^\p{L}\p{N}]*$/u.test(opensQuote ? token.slice(1) : token)) quoted = false
    if (word === '') {
      if (PHRASE_END.test(token)) position = 0
      continue
    }
    if (!inQuote) {
      const parts = word.replace(/['’]s$/, '').split('-')
      parts.forEach((part, i) => {
        if ((position > 0 || i > 0) && /^[A-Z][a-z]+$/.test(part) && !PROPER_NOUNS.has(part)) {
          flagged.push(part)
        }
      })
    }
    position = PHRASE_END.test(token) ? 0 : position + 1
  }
  return flagged
}

const hasAsciiEllipsis = (text) => text.replace(/\/\.\.\.(?=[A-Za-z_])/g, '/').includes('...')
const hasSuccessfully = (text) => /successfully/i.test(text)

/**
 * The strings an expression can evaluate to, as far as the source shows:
 * literals, templates (interpolations become SLOT), both sides of
 * conditionals and `||`/`??`, and the right side of `&&`.
 */
function stringsOf(expr) {
  if (!expr) return []
  if (ts.isParenthesizedExpression(expr)) return stringsOf(expr.expression)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return [{ text: expr.text, node: expr }]
  }
  if (ts.isTemplateExpression(expr)) {
    const text = [
      expr.head.text,
      ...expr.templateSpans.map((s) => ` ${SLOT} ${s.literal.text}`),
    ].join('')
    return [{ text, node: expr }]
  }
  if (ts.isConditionalExpression(expr))
    return [...stringsOf(expr.whenTrue), ...stringsOf(expr.whenFalse)]
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return [...stringsOf(expr.left), ...stringsOf(expr.right)]
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return stringsOf(expr.right)
  }
  return []
}

function tagName(node) {
  return node.tagName.getText()
}

const isJsx = (expr) =>
  ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)
const RENDERS_NOTHING = new Set(['null', 'undefined', 'true', 'false'])

/**
 * What a JSX child expression can render, as text: a literal is its text, an
 * element is a word break, null/undefined/booleans render nothing, `&&` renders
 * its right side or nothing, and any other value stands in as SLOT.
 */
function childOptions(expr) {
  if (!expr) return ['']
  if (ts.isParenthesizedExpression(expr)) return childOptions(expr.expression)
  if (isJsx(expr)) return [' ']
  if (RENDERS_NOTHING.has(expr.getText())) return ['']
  if (ts.isConditionalExpression(expr)) {
    return [...childOptions(expr.whenTrue), ...childOptions(expr.whenFalse)]
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...childOptions(expr.left), ...childOptions(expr.right)]
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return [...childOptions(expr.right), '']
  }
  const strings = stringsOf(expr)
  return strings.length > 0 ? strings.map((s) => s.text) : [` ${SLOT} `]
}

/** Every text an element can show, one per combination of its children's options. */
function* elementTexts(element) {
  const lists = element.children.map((child) => {
    if (ts.isJsxText(child)) return [child.text]
    if (ts.isJsxExpression(child)) return [...new Set(childOptions(child.expression))]
    return [' ']
  })
  function* combine(i, prefix) {
    if (i === lists.length) yield prefix.replace(/\s+/g, ' ').trim()
    else for (const option of lists[i]) yield* combine(i + 1, prefix + option)
  }
  yield* combine(0, '')
}

function propertyKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return undefined
}

function isSkipped(node) {
  let parent = node.parent
  while (
    parent &&
    (ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isTemplateLiteralTypeSpan(parent) ||
      ts.isParenthesizedExpression(parent))
  ) {
    parent = parent.parent
  }
  if (!parent) return false
  if (ts.isLiteralTypeNode(parent) || ts.isTemplateLiteralTypeNode(parent)) return true
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true
  if (ts.isExternalModuleReference(parent)) return true
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression
    if (ts.isIdentifier(callee) && callee.text === 'require') return true
    if (ts.isImportKeyword?.(callee) || callee.kind === ts.SyntaxKind.ImportKeyword) return true
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'console'
    ) {
      return true
    }
  }
  return false
}

const parse = (fileName, source) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** Every finding in one source file, as { rule, line, text }. */
function scanSource(fileName, source) {
  return scanFile(parse(fileName, source))
}

function scanFile(sf) {
  const findings = []
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const add = (rule, node, text) =>
    findings.push({
      rule,
      line: lineOf(node),
      text: text.replaceAll(SLOT, '{…}').trim().slice(0, 100),
    })
  const checkLabel = (text, node) => {
    if (titleCaseWords(text).length > 0) add('title-case', node, text)
  }

  const visit = (node) => {
    let text
    if (ts.isJsxText(node)) text = node.text
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      text = node.text
    }
    if (text !== undefined && !isSkipped(node)) {
      if (hasAsciiEllipsis(text)) add('ellipsis', node, text)
      if (hasSuccessfully(text)) add('successfully', node, text)
    }

    if (ts.isJsxElement(node) && LABEL_ELEMENTS.has(tagName(node.openingElement))) {
      for (const text of elementTexts(node)) {
        if (titleCaseWords(text).length > 0) {
          add('title-case', node, text)
          break
        }
      }
    }
    if (ts.isJsxAttribute(node) && LABEL_KEYS.has(node.name.getText()) && node.initializer) {
      const init = node.initializer
      const strings = ts.isJsxExpression(init) ? stringsOf(init.expression) : stringsOf(init)
      for (const s of strings) checkLabel(s.text, s.node)
    }
    if (ts.isPropertyAssignment(node) && LABEL_KEYS.has(propertyKey(node.name))) {
      for (const s of stringsOf(node.initializer)) checkLabel(s.text, s.node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/**
 * The relative module specifiers whose values `sf` loads: imports, re-exports and dynamic
 * `import()`s, minus the type-only ones, which load nothing.
 */
function valueImports(sf) {
  const specifiers = []
  const typeOnly = (elements) => elements.length > 0 && elements.every((e) => e.isTypeOnly)
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const onlyTypes =
        clause &&
        (clause.isTypeOnly ||
          (!clause.name && bindings && ts.isNamedImports(bindings) && typeOnly(bindings.elements)))
      if (!onlyTypes) specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const exported = node.exportClause
      const onlyTypes =
        node.isTypeOnly || (exported && ts.isNamedExports(exported) && typeOnly(exported.elements))
      if (!onlyTypes) specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specifiers.filter((spec) => spec.startsWith('.'))
}

/** The source file a relative specifier names, or undefined outside src/ or when none exists. */
function resolveModule(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier.replace(/\.[jt]sx?$/, ''))
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && candidate.startsWith(SRC_ROOT + sep)) return candidate
  }
  return undefined
}

function walk(absDir, out) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(join(absDir, entry.name), out)
    } else if (/\.tsx?$/.test(entry.name) && !EXCLUDED_BASENAME.test(entry.name)) {
      out.push(join(absDir, entry.name))
    }
  }
  return out
}

function selfTest() {
  const labelCases = [
    ['Save', []],
    ['Submit for review', []],
    ['Submit Branch', ['Branch']],
    ['Change / Manage Branches', ['Manage', 'Branches']],
    ['Open in GitHub', []],
    ['Edit JSON', []],
    ['Sign in with Clerk', []],
    ['main · Protected', []],
    ['Saved. Undo', []],
    ['Error: Could not save', []],
    ['Delete "About Us"?', []],
    ['Rename “Home Page” Entry', ['Entry']],
    ['+ New', []],
    ['Write a Reply', ['Reply']],
    ['Open Sign-In', ['Sign', 'In']],
    ['Read-Only mode', ['Only']],
    ['Open the Editor’s menu', ['Editor']],
    [`${SLOT} : Select all`, []],
    [`${SLOT} : Select All`, ['All']],
    [`Delete ${SLOT} Branch`, ['Branch']],
    [`${SLOT} Files`, ['Files']],
    ['Add Entry', ['Entry']],
    ['New branch…', []],
  ]
  const sourceCases = [
    ['<Button>Delete Branch</Button>', ['title-case']],
    ['<Button>Delete branch</Button>', []],
    ['<Menu.Item onClick={f}>Reload All Files</Menu.Item>', ['title-case']],
    ['<Button>Delete {name} Group</Button>', ['title-case']],
    ['<Text>Some Heading Text</Text>', []],
    ['<TextInput label="Branch Name" />', ['title-case']],
    ['<TextInput placeholder="Blog Posts" />', ['title-case']],
    ['<TextInput placeholder="Blog posts" />', []],
    ['<DestructiveMenuItem>Delete Branch</DestructiveMenuItem>', ['title-case']],
    ['<Tooltip label={open ? "Hide Panel" : "Show panel"} />', ['title-case']],
    [
      'notifications.show({ title: "Branch Created", message: "Saved successfully" })',
      ['title-case', 'successfully'],
    ],
    [
      'modals.openConfirmModal({ labels: { confirm: "Delete Branch", cancel: "Cancel" } })',
      ['title-case'],
    ],
    ['const x = { kind: "Some Title Case" }', []],
    ['<Button>Submit branch...</Button>', ['ellipsis']],
    ['const t = `Saving ${n}...`', ['ellipsis']],
    ['console.warn("Retrying...")', []],
    ["buildPath('/:branch/content/...path', params)", []],
    ['<Button>Open /docs...</Button>', ['ellipsis']],
    ["import x from '...'", []],
    ['setError("Saved Successfully")', ['successfully']],
    ['<Button>Saving…</Button>', []],
    ['<Button>{open ? "Hide Panel" : "Show panel"}</Button>', ['title-case']],
    ['<Button>{open ? "Hide panel" : "Show panel"}</Button>', []],
    ['<Button>{busy && "Delete Branch"}</Button>', ['title-case']],
    ['<Button>{/* note */}Delete branch</Button>', []],
    ['<Menu.Item><IconX /> Reload page</Menu.Item>', []],
    ['<Button>{count} Files</Button>', ['title-case']],
    ['<Button>{open ? "Show panel" : "Hide Panel"}</Button>', ['title-case']],
    ['<Button>{a ? "Save" : "Delete"}{b ? " all" : " All"}</Button>', ['title-case']],
    ['<Button>Retry{done && "."} Now</Button>', ['title-case']],
    ['<Button>{count ?? ""} Files</Button>', ['title-case']],
    ['<Button>{loading && <Loader />} Save</Button>', []],
    ['<Button>{busy ? null : ""} Delete branch</Button>', []],
    ['console.log((`Retrying ${n}...`))', []],
    ['type T = `Saving ${string}...`', []],
    ['console.error(`Retrying ${n}...`)', []],
    ['type Mode = "..."', []],
  ]
  const importCases = [
    ["import a from './a'", ['./a']],
    ["import type { T } from './t'", []],
    ["import { type T } from './t'", []],
    ["import { type T, v } from './t'", ['./t']],
    ["import def, { type T } from './d'", ['./d']],
    ["import * as ns from './n'", ['./n']],
    ["import './side'", ['./side']],
    ["import x from 'react'", []],
    ["export * from './b'", ['./b']],
    ["export { x } from './b'", ['./b']],
    ["export type { T } from './b'", []],
    ["export { type T } from './b'", []],
    ['export const x = 1', []],
    ["const m = await import('./lazy')", ['./lazy']],
  ]
  const failures = []
  for (const [source, expected] of importCases) {
    const actual = valueImports(parse('case.tsx', source))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `valueImports(${source}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      )
    }
  }
  const editorFile = join(SCOPE, 'Editor.tsx')
  const resolutions = [
    [editorFile, '../api/entries-constants', 'api/entries-constants.ts'],
    [editorFile, '../authorization', 'authorization/index.ts'],
    [editorFile, './components/EditorHeader', 'editor/components/EditorHeader.tsx'],
    [editorFile, './components/EditorHeader.js', 'editor/components/EditorHeader.tsx'],
    [editorFile, '../../../../package.json', undefined],
    [editorFile, './no-such-module', undefined],
  ]
  for (const [from, specifier, expected] of resolutions) {
    const resolved = resolveModule(from, specifier)
    const actual = resolved && relative(SRC_ROOT, resolved).split(sep).join('/')
    if (actual !== expected) {
      failures.push(`resolveModule(${specifier}) = ${actual}, expected ${expected}`)
    }
  }
  for (const [text, expected] of labelCases) {
    const actual = titleCaseWords(text)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `titleCaseWords(${JSON.stringify(text)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      )
    }
  }
  for (const [source, expected] of sourceCases) {
    const actual = [...new Set(scanSource('case.tsx', source).map((f) => f.rule))].sort()
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      failures.push(
        `scan(${source}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      )
    }
  }
  if (failures.length > 0) {
    console.error('check-ux-copy self-test FAILED:')
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log(
    `check-ux-copy self-test passed (${labelCases.length} label cases, ${sourceCases.length} source cases, ${importCases.length} import cases, ${resolutions.length} resolutions).`,
  )
  process.exit(0)
}

const args = process.argv.slice(2)
if (args.includes('--self-test')) selfTest()

/** The editor's files and, transitively, every src/ file they load through value imports. */
function scannedFiles() {
  const seen = new Set(walk(SCOPE, []))
  const queue = [...seen]
  const parsed = new Map()
  while (queue.length > 0) {
    const abs = queue.pop()
    const sf = parse(abs, readFileSync(abs, 'utf8'))
    parsed.set(abs, sf)
    for (const specifier of valueImports(sf)) {
      const target = resolveModule(abs, specifier)
      if (!target || seen.has(target)) continue
      if (EXCLUDED_BASENAME.test(target) || target.split(sep).some((d) => EXCLUDED_DIRS.has(d)))
        continue
      seen.add(target)
      queue.push(target)
    }
  }
  return parsed
}

const results = [...scannedFiles()]
  .map(([abs, sf]) => ({ file: rel(abs), findings: scanFile(sf) }))
  .sort((a, b) => a.file.localeCompare(b.file))

/** file -> rule -> count, for files with at least one finding. */
function countsOf(list) {
  const counts = {}
  for (const { file, findings } of list) {
    for (const f of findings) {
      counts[file] ??= {}
      counts[file][f.rule] = (counts[file][f.rule] ?? 0) + 1
    }
  }
  return counts
}
const actual = countsOf(results)

if (args.includes('--report')) {
  for (const { file, findings } of results) {
    for (const f of findings) console.log(`${file}:${f.line} [${f.rule}] ${f.text}`)
  }
  process.exit(0)
}

const baseline = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')).files ?? {})
  : {}

if (args.includes('--write-baseline')) {
  const raises = []
  for (const [file, rules] of Object.entries(actual)) {
    for (const [rule, count] of Object.entries(rules)) {
      if (count > (baseline[file]?.[rule] ?? 0))
        raises.push(`${file} ${rule} ${baseline[file]?.[rule] ?? 0} -> ${count}`)
    }
  }
  if (raises.length > 0 && existsSync(baselinePath) && !args.includes('--allow-raise')) {
    console.error(
      `❌ refusing to raise ${raises.length} count(s); pass --allow-raise to do it on purpose:`,
    )
    for (const r of raises) console.error(`    ${r}`)
    process.exit(1)
  }
  const out = {
    $comment:
      'Per-file copy-rule counts read by scripts/check-ux-copy.mjs (pnpm lint:ux-copy). Regenerate with `node scripts/check-ux-copy.mjs --write-baseline`; a rewrite that raises a count is refused without --allow-raise.',
    files: actual,
  }
  writeFileSync(baselinePath, JSON.stringify(out, null, 2) + '\n')
  const total = Object.values(actual).reduce(
    (n, r) => n + Object.values(r).reduce((a, b) => a + b, 0),
    0,
  )
  console.log(`📝 wrote baseline: ${total} finding(s) in ${Object.keys(actual).length} file(s)`)
  process.exit(0)
}

const problems = []
const files = new Set([...Object.keys(actual), ...Object.keys(baseline)])
for (const file of [...files].sort()) {
  const rules = new Set([...Object.keys(actual[file] ?? {}), ...Object.keys(baseline[file] ?? {})])
  for (const rule of [...rules].sort()) {
    const now = actual[file]?.[rule] ?? 0
    const allowed = baseline[file]?.[rule] ?? 0
    if (now > allowed) {
      const detail = results
        .find((r) => r.file === file)
        .findings.filter((f) => f.rule === rule)
        .map((f) => `${file}:${f.line} ${f.text}`)
      problems.push([`${file}: ${rule} ${now} > baseline ${allowed}`, ...detail])
    } else if (now < allowed) {
      problems.push([
        `${file}: ${rule} ${now} < baseline ${allowed} -- record the fix with \`node scripts/check-ux-copy.mjs --write-baseline\``,
      ])
    }
  }
}

if (problems.length === 0) {
  const total = Object.values(actual).reduce(
    (n, r) => n + Object.values(r).reduce((a, b) => a + b, 0),
    0,
  )
  console.log(
    `✅ editor copy, including what it imports from outside editor/, within baseline (${results.length} files, ${total} baselined finding(s))`,
  )
  process.exit(0)
}
console.error(
  `❌ editor copy, including what it imports from outside editor/, has ${problems.length} problem(s):\n`,
)
for (const [first, ...detail] of problems) {
  console.error(`  ${first}`)
  for (const d of detail) console.error(`      ${d}`)
}
console.error('\nRules: docs/ux-guidelines.md. Classifier: scripts/check-ux-copy.mjs.')
process.exit(1)
