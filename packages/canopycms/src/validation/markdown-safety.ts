/**
 * The save-time policy that keeps code out of `markdown` and `mdx` content.
 *
 * MDX compiles `{expressions}`, `import`/`export` and JSX into JavaScript, so whatever renders a
 * body with `evaluate` or `run` executes it: in a preview, on the CMS origin with the viewer's
 * session; in a server render, in the CMS process; in a build, on CI. A body this policy accepts
 * runs only the site's own components. An `mdx` field, and the body of an `mdx` entry, accepts:
 *
 * - no `import`/`export`, and no `{…}` expression except a comment or a static literal
 *   (`{300}`, `{["a", "b"]}`), in text or as an attribute value; no spread attributes;
 * - components by plain name (`<Callout>`, the site's own code) and HTML tags from
 *   `SAFE_HTML_TAGS` only, since a tag is a real element whose attributes need no expression to
 *   run code (`<script>`, `<iframe srcdoc>`);
 * - no event-handler, `dangerouslySetInnerHTML` or `srcdoc` attribute on any element;
 * - URLs, in links, images, definitions and URL attributes, that are relative or use a scheme in
 *   `SAFE_URL_SCHEMES`. React 18 renders a `javascript:` href as given.
 *
 * Markdown (`markdown` fields, the body of an `md` entry) renders braces, imports and tags as
 * text, so only its URLs are checked. A field with `executable: true` is not checked at all.
 *
 * A body is parsed with and without GFM and the issues of both kept, so a site's choice of
 * `remark-gfm` cannot hide a construct from the check, and an MDX body that does not parse is
 * refused, since it cannot be checked.
 *
 * A save may keep code the stored entry already holds in the same field, which came from outside
 * the CMS or from before this policy, so an author can still edit around it: `splitByStored`
 * matches each construct by its key, and refuses one that is new, changed, copied or moved to
 * another field. A key holds everything that decides what the construct runs, so `import`/`export`,
 * which every element in the field can reach, is kept only in a field saved unchanged.
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mdxFromMarkdown } from 'mdast-util-mdx'
import { gfm } from 'micromark-extension-gfm'
import { mdxjs } from 'micromark-extension-mdxjs'

import type { ContentFormat, EntrySchema, FieldConfig } from '../config'
import { findBodyFieldName } from '../utils/body-field'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { getErrorMessage } from '../utils/error'
import type { EntryFieldError } from './entry-validator'
import { traverseFields } from './field-traversal'

type MarkdownDialect = 'md' | 'mdx'

interface MarkdownSafetyIssue {
  message: string
  /** 1-based line in the checked source, when known. */
  line?: number
  /** The construct's identity, its source with no position; none when it cannot be kept. */
  key?: string
}

/** One field's issues. */
export interface MarkdownSafetyFinding {
  fieldPath: string
  issues: MarkdownSafetyIssue[]
}

/** HTML tags an MDX body may use: content elements whose attributes carry no code. */
const SAFE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'audio',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
])

/** `entry:` is CanopyCMS's own link to an entry, which the site resolves to a path. */
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'entry'])

/** A `data:` URL is accepted only as a raster image, which no browser runs as a document. */
const SAFE_DATA_URL = /^data:image\/(?:png|gif|jpe?g|webp|avif)[;,]/i

/**
 * Attribute names, lower-cased with non-letters removed, that `SAFE_HTML_TAGS` load as a URL or
 * that a component commonly passes on to one. `data` is left out: it is a URL only on `<object>`,
 * which is not a safe tag, and a common component prop.
 */
const URL_ATTRIBUTES = new Set([
  'action',
  'cite',
  'formaction',
  'href',
  'ping',
  'poster',
  'src',
  'srcset',
  'to',
  'url',
  'xlinkhref',
])

/** Attribute names, lower-cased, that put markup or a document into the page. */
const FORBIDDEN_ATTRIBUTES = new Set(['dangerouslysetinnerhtml', 'srcdoc'])

/** The mdast shape this module reads. */
interface MdNode {
  readonly type: string
  readonly children?: readonly MdNode[]
  readonly position?: { readonly start: { readonly line: number } }
  readonly name?: string | null
  /** An expression's or ESM block's code. */
  readonly value?: unknown
  readonly url?: string
  /** A definition's, or a link or image reference's, normalised label. */
  readonly identifier?: string
  /** An MDX JSX element's attributes; other node types use the key for other shapes. */
  readonly attributes?: unknown
  readonly data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** True when an ESTree expression is literal data: no identifier, call, function or spread. */
function isStaticValue(node: unknown): boolean {
  if (!isRecord(node)) return false
  switch (node.type) {
    case 'Literal':
      return true
    case 'TemplateLiteral':
      return Array.isArray(node.expressions) && node.expressions.length === 0
    case 'UnaryExpression':
      return (
        (node.operator === '-' || node.operator === '+') &&
        isRecord(node.argument) &&
        node.argument.type === 'Literal' &&
        typeof node.argument.value === 'number'
      )
    case 'ArrayExpression':
      return (
        Array.isArray(node.elements) &&
        node.elements.every((element) => element === null || isStaticValue(element))
      )
    case 'ObjectExpression':
      return (
        Array.isArray(node.properties) &&
        // A method or accessor's value is a function, so the value check refuses it too.
        node.properties.every(
          (property) =>
            isRecord(property) &&
            property.type === 'Property' &&
            property.computed === false &&
            isStaticValue(property.value),
        )
      )
    default:
      return false
  }
}

/** The program MDX parsed an expression node's code into, if it did. */
function estreeOf(node: { readonly data?: unknown }): unknown {
  return isRecord(node.data) ? node.data.estree : undefined
}

/**
 * True when an expression's parsed program holds no code: only comments, or one static value.
 * A missing program (it was not parsed) holds code as far as this check knows.
 */
function isInertProgram(estree: unknown): boolean {
  if (!isRecord(estree) || !Array.isArray(estree.body)) return false
  if (estree.body.length === 0) return true
  if (estree.body.length > 1) return false
  const [statement] = estree.body
  return (
    isRecord(statement) &&
    statement.type === 'ExpressionStatement' &&
    isStaticValue(statement.expression)
  )
}

/** The scheme a browser would read from `url`, lower-cased, or undefined for a relative URL. */
function urlScheme(url: string): string | undefined {
  // Browsers drop ASCII tab and newline anywhere and C0 controls and spaces at the ends;
  // dropping every one of them anywhere can only find a scheme where a browser finds none.
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\u0000-\u0020\u007f]/g, '')
  return /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase()
}

function unsafeUrlScheme(url: string): string | undefined {
  const scheme = urlScheme(url)
  if (scheme === undefined || SAFE_URL_SCHEMES.has(scheme)) return undefined
  if (scheme === 'data' && SAFE_DATA_URL.test(url.trim())) return undefined
  return scheme
}

/**
 * The scheme of a value that runs script if it reaches an `href` or `src`, which a component may
 * do with any prop: checked on every string a prop holds. `data:` is left to the URL attributes,
 * since a data document runs in an opaque origin and prose often starts with "Data:".
 */
function scriptScheme(value: string): string | undefined {
  const scheme = urlScheme(value)
  return scheme === 'javascript' || scheme === 'vbscript' ? scheme : undefined
}

/** Every string in a static value: literals, template text, and array and object values. */
function staticStrings(node: unknown): string[] {
  if (!isRecord(node)) return []
  switch (node.type) {
    case 'Program':
      return Array.isArray(node.body) ? node.body.flatMap(staticStrings) : []
    case 'ExpressionStatement':
      return staticStrings(node.expression)
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : []
    case 'TemplateLiteral':
      return Array.isArray(node.quasis)
        ? node.quasis.flatMap((quasi) =>
            isRecord(quasi) && isRecord(quasi.value) && typeof quasi.value.cooked === 'string'
              ? [quasi.value.cooked]
              : [],
          )
        : []
    case 'ArrayExpression':
      return Array.isArray(node.elements) ? node.elements.flatMap(staticStrings) : []
    case 'ObjectExpression':
      return Array.isArray(node.properties)
        ? node.properties.flatMap((property) =>
            isRecord(property) ? staticStrings(property.value) : [],
          )
        : []
    default:
      return []
  }
}

/** Each URL a `srcset` names: the first token of every comma-separated candidate. */
function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '')
}

/**
 * A JSX name MDX resolves from the site's components rather than rendering as an HTML tag. A name
 * led by `_` or `$` could name one of MDX's own bindings, as could the two below.
 */
const COMPONENT_NAME = /^[A-Z][\w$]*$/
const MDX_BINDINGS = new Set(['MDXContent', 'MDXLayout'])

/** Where an issue sits, as the editor shows it. */
const at = (node: MdNode) => (node.position ? ` (line ${node.position.start.line})` : '')

function issue(node: MdNode, message: string, key: string | undefined): MarkdownSafetyIssue {
  return { message: `${message}${at(node)}`, line: node.position?.start.line, key }
}

/**
 * The identity `splitByStored` matches a construct by: its tree with positions and parse data
 * dropped. That is what it compiles from, so the same raw text in another container (a quote's
 * `> ` prefix, a list's indent) is a different construct.
 */
function treeKey(kind: string, node: unknown): string {
  return `${kind}\0${JSON.stringify(node, (name, value: unknown) =>
    name === 'position' || name === 'data' ? undefined : value,
  )}`
}

function urlIssue(node: MdNode, url: string, where: string): MarkdownSafetyIssue | undefined {
  const scheme = unsafeUrlScheme(url)
  if (scheme === undefined) return undefined
  return issue(
    node,
    `The URL scheme "${scheme}:" is not allowed in ${where}; use http(s), mailto, tel, an entry link or a path on the site`,
    `url\0${where}\0${JSON.stringify(url)}`,
  )
}

function checkJsxElement(node: MdNode): MarkdownSafetyIssue[] {
  const name = node.name
  // A fragment (`<>…</>`) renders its children and nothing else.
  if (name === null || name === undefined) return []
  const tag = `<${name}>`
  const isComponent = COMPONENT_NAME.test(name) && !MDX_BINDINGS.has(name)
  if (!isComponent && !SAFE_HTML_TAGS.has(name)) {
    return [
      issue(
        node,
        name.includes('.')
          ? `${tag} is not allowed: use a component by its plain name`
          : `${tag} is not allowed: it is not one of the HTML tags a body may use, so use one of the site's components instead`,
        // A component's children are markdown, checked on their own, so editing them keeps it. An
        // HTML tag's are its content, raw text that runs inside `<script>` or `<style>`.
        name.includes('.')
          ? treeKey('tag', { name, attributes: node.attributes })
          : treeKey('tag', node),
      ),
    ]
  }
  const issues: MarkdownSafetyIssue[] = []
  const attributes: unknown[] = Array.isArray(node.attributes) ? node.attributes : []
  for (const attribute of attributes) {
    if (
      !isRecord(attribute) ||
      attribute.type !== 'mdxJsxAttribute' ||
      typeof attribute.name !== 'string'
    ) {
      issues.push(
        issue(
          node,
          `{…} spread attributes are not allowed on ${tag}`,
          treeKey('spread', [name, attribute]),
        ),
      )
      continue
    }
    const attributeName = attribute.name
    const value = attribute.value
    const key = treeKey('attribute', [name, attribute])
    const lower = attributeName.toLowerCase()
    // A tag's `on…` attribute is a handler in any spelling; a component's prop is one by React's
    // convention, so `online` or `onlyMobile` stays a plain prop.
    if (isComponent ? /^on[A-Z]/.test(attributeName) : /^on/.test(lower)) {
      issues.push(
        issue(node, `${attributeName} on ${tag} is not allowed: event handlers run code`, key),
      )
      continue
    }
    if (FORBIDDEN_ATTRIBUTES.has(lower)) {
      issues.push(issue(node, `${attributeName} on ${tag} is not allowed`, key))
      continue
    }
    const isUrl = URL_ATTRIBUTES.has(lower.replace(/[^a-z]/g, ''))
    if (isRecord(value) && (isUrl || !isInertProgram(estreeOf(value)))) {
      issues.push(
        issue(
          node,
          isUrl
            ? `${attributeName} on ${tag} must be a plain "string"`
            : `${attributeName} on ${tag} must be a plain value, such as "text" or {300}`,
          key,
        ),
      )
      continue
    }
    if (isUrl && typeof value === 'string') {
      const urls = lower === 'srcset' ? srcsetUrls(value) : [value]
      for (const url of urls) {
        const found = urlIssue(node, url, `${attributeName} on ${tag}`)
        if (found) issues.push(found)
      }
      continue
    }
    const strings =
      typeof value === 'string' ? [value] : isRecord(value) ? staticStrings(estreeOf(value)) : []
    for (const text of strings) {
      const scheme = scriptScheme(text)
      if (scheme === undefined) continue
      issues.push(
        issue(
          node,
          `The URL scheme "${scheme}:" is not allowed in ${attributeName} on ${tag}, which a component may use as a link`,
          key,
        ),
      )
    }
  }
  return issues
}

/** What checking one tree needs beyond its nodes. */
interface CheckContext {
  /** The whole field's source, the key of its ESM. */
  readonly field: string
  readonly definitions: ReadonlyMap<string, string>
}

function checkNode(node: MdNode, context: CheckContext): MarkdownSafetyIssue[] {
  const { definitions } = context
  const issues: MarkdownSafetyIssue[] = []
  switch (node.type) {
    case 'mdxjsEsm':
      issues.push(
        issue(
          node,
          'import/export statements are not allowed: they run as code',
          // What it defines can be called by any JSX in the field, and a default export receives
          // all of it, so it is kept only in a field saved unchanged.
          treeKey('esm', context.field),
        ),
      )
      break
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
      if (!isInertProgram(estreeOf(node))) {
        issues.push(
          issue(
            node,
            '{…} expressions are not allowed: they run as code. A comment {/* … */} or a plain value such as {" "} is fine',
            // Its code alone, so moving it between a line of its own and a sentence keeps it.
            treeKey('expression', node.value),
          ),
        )
      }
      break
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      issues.push(...checkJsxElement(node))
      break
    case 'link':
    case 'image':
    case 'definition': {
      const found =
        node.url === undefined ? undefined : urlIssue(node, node.url, URL_SITES[node.type] ?? '')
      if (found) issues.push(found)
      break
    }
    // A reference loads its definition's URL. Checked where it is used, so that keeping a stored
    // definition with no reference to it never licenses a new one.
    case 'linkReference':
    case 'imageReference': {
      const url = node.identifier === undefined ? undefined : definitions.get(node.identifier)
      const found = url === undefined ? undefined : urlIssue(node, url, URL_SITES[node.type] ?? '')
      if (found) issues.push(found)
      break
    }
  }
  for (const child of node.children ?? []) issues.push(...checkNode(child, context))
  return issues
}

/** How an issue names each node that carries a URL; also part of the issue's key. */
const URL_SITES: Partial<Record<string, string>> = {
  link: 'a link',
  image: 'an image',
  definition: 'a definition',
  linkReference: 'a link reference',
  imageReference: 'an image reference',
}

/** Each definition's URL by label. The first definition of a label is the one that applies. */
function collectDefinitions(node: MdNode, into = new Map<string, string>()): Map<string, string> {
  if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined) {
    if (!into.has(node.identifier)) into.set(node.identifier, node.url)
  }
  for (const child of node.children ?? []) collectDefinitions(child, into)
  return into
}

function parse(source: string, dialect: MarkdownDialect, withGfm: boolean): MdNode {
  const extensions = [...(withGfm ? [gfm()] : []), ...(dialect === 'mdx' ? [mdxjs()] : [])]
  const mdastExtensions = [
    ...(withGfm ? [gfmFromMarkdown()] : []),
    ...(dialect === 'mdx' ? [mdxFromMarkdown()] : []),
  ]
  return fromMarkdown(source, { extensions, mdastExtensions })
}

/**
 * Every construct in `source` that runs code, or loads a URL that does, when it renders.
 * @internal Exported for tests.
 */
export function findUnsafeMarkdown(
  source: string,
  dialect: MarkdownDialect,
): MarkdownSafetyIssue[] {
  // Line endings are not part of what MDX compiles, and an editor saves a CRLF file as LF.
  const field = source.replace(/\r\n?/g, '\n')
  const parses: MarkdownSafetyIssue[][] = []
  for (const withGfm of [false, true]) {
    let tree: MdNode
    try {
      tree = parse(field, dialect, withGfm)
    } catch (err: unknown) {
      return [
        { message: `This MDX does not parse, so it cannot be checked: ${getErrorMessage(err)}` },
      ]
    }
    let found: MarkdownSafetyIssue[]
    try {
      found = checkNode(tree, { field, definitions: collectDefinitions(tree) })
    } catch (err: unknown) {
      // Nesting deep enough to exhaust the stack.
      return [{ message: `This body is too deeply nested to check: ${getErrorMessage(err)}` }]
    }
    parses.push(found)
  }
  // Both parses report most constructs. Each is kept as many times as the parse that saw it most
  // did, so a second construct like the first, on the same line, is still counted.
  const id = (item: MarkdownSafetyIssue) => `${item.line ?? ''}\0${item.key ?? item.message}`
  const [plain = [], withGfm = []] = parses
  const unmatched = new Map<string, number>()
  for (const item of plain) unmatched.set(id(item), (unmatched.get(id(item)) ?? 0) + 1)
  const issues = [...plain]
  for (const item of withGfm) {
    const count = unmatched.get(id(item)) ?? 0
    if (count > 0) unmatched.set(id(item), count - 1)
    else issues.push(item)
  }
  // The same construct runs differently as markdown and as MDX, so the dialect is part of its key.
  return issues.map((item) =>
    item.key === undefined ? item : { ...item, key: `${dialect}\0${item.key}` },
  )
}

/** The field's one message: its first issue, and how many more there are. */
function toFieldError(fieldPath: string, issues: MarkdownSafetyIssue[]): EntryFieldError {
  const [first, ...rest] = issues
  const more = rest.length === 0 ? '' : ` (and ${rest.length} more)`
  return { fieldPath, message: `${first?.message ?? ''}${more}` }
}

function dialectOfField(field: FieldConfig): MarkdownDialect | undefined {
  if ('executable' in field && field.executable === true) return undefined
  if (field.type === 'mdx') return 'mdx'
  if (field.type === 'markdown') return 'md'
  return undefined
}

function findInValue(
  fieldPath: string,
  value: unknown,
  dialect: MarkdownDialect,
): MarkdownSafetyFinding[] {
  const values = Array.isArray(value) ? value : [value]
  const findings: MarkdownSafetyFinding[] = []
  values.forEach((item, index) => {
    if (typeof item !== 'string' || item === '') return
    const issues = findUnsafeMarkdown(item, dialect)
    if (issues.length === 0) return
    findings.push({
      fieldPath: Array.isArray(value) ? `${fieldPath}[${index}]` : fieldPath,
      issues,
    })
  })
  return findings
}

/**
 * The policy's issues in one entry's on-disk-shaped data, the body merged in under the schema's
 * body field name. The body of an `md`/`mdx` entry is checked in the entry's format whatever its
 * field's type, and is checked when the schema declares no body field; it is exempt only when
 * its field is `executable`.
 */
export function findMarkdownSafetyIssues(
  fields: EntrySchema,
  format: ContentFormat | undefined,
  data: Record<string, unknown>,
): MarkdownSafetyFinding[] {
  const hasBody = format === 'md' || format === 'mdx'
  const bodyName = hasBody ? findBodyFieldName(fields) : undefined
  const findings: MarkdownSafetyFinding[] = []

  if (hasBody && bodyName !== undefined) {
    const bodyField = flattenGroupFields(fields).find((field) => field.name === bodyName)
    const executable =
      bodyField !== undefined && 'executable' in bodyField && bodyField.executable === true
    if (!executable) findings.push(...findInValue(bodyName, data[bodyName], format))
  }

  findings.push(
    ...traverseFields<MarkdownSafetyFinding>(fields, data, ({ field, value, path }) => {
      if (path === bodyName) return []
      const dialect = dialectOfField(field)
      return dialect === undefined ? [] : findInValue(path, value, dialect)
    }),
  )
  return findings
}

/** A field with list and block positions dropped, so reordering items keeps a match. */
const site = (fieldPath: string) => fieldPath.replace(/\[\d+\]/g, '')

/**
 * Splits a save's issues into those it adds, which refuse it, and those the stored entry already
 * held in the same field, which it keeps. Constructs are matched by key and counted, so a copy
 * of a stored construct is refused, as is one moved to a field of another name. An issue with no
 * key, such as a body that does not parse, is never kept.
 */
export function splitByStored(
  found: readonly MarkdownSafetyFinding[],
  stored: readonly MarkdownSafetyFinding[],
): { refused: EntryFieldError[]; kept: EntryFieldError[] } {
  const available = new Map<string, number>()
  for (const finding of stored) {
    for (const { key } of finding.issues) {
      if (key === undefined) continue
      const id = `${site(finding.fieldPath)}\0${key}`
      available.set(id, (available.get(id) ?? 0) + 1)
    }
  }
  const refused: EntryFieldError[] = []
  const kept: EntryFieldError[] = []
  for (const finding of found) {
    const added: MarkdownSafetyIssue[] = []
    const held: MarkdownSafetyIssue[] = []
    for (const item of finding.issues) {
      const id = item.key === undefined ? undefined : `${site(finding.fieldPath)}\0${item.key}`
      const count = id === undefined ? 0 : (available.get(id) ?? 0)
      if (id !== undefined && count > 0) {
        available.set(id, count - 1)
        held.push(item)
      } else {
        added.push(item)
      }
    }
    if (added.length > 0) refused.push(toFieldError(finding.fieldPath, added))
    if (held.length > 0) kept.push(toFieldError(finding.fieldPath, held))
  }
  return { refused, kept }
}
