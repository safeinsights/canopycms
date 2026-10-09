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
 * refused, since it cannot be checked. Pure and isomorphic: the editor runs it before a save and
 * the server at the write boundary.
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
  readonly url?: string
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

/** Each URL a `srcset` names: the first token of every comma-separated candidate. */
function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '')
}

/** A JSX name MDX resolves from the site's components rather than rendering as an HTML tag. */
const COMPONENT_NAME = /^[A-Z_$][\w$]*$/

/** Where an issue sits, as the editor shows it. */
const at = (node: MdNode) => (node.position ? ` (line ${node.position.start.line})` : '')

function issue(node: MdNode, message: string): MarkdownSafetyIssue {
  return { message: `${message}${at(node)}`, line: node.position?.start.line }
}

function urlIssue(node: MdNode, url: string, where: string): MarkdownSafetyIssue | undefined {
  const scheme = unsafeUrlScheme(url)
  if (scheme === undefined) return undefined
  return issue(
    node,
    `The URL scheme "${scheme}:" is not allowed in ${where}; use http(s), mailto, tel, an entry link or a path on the site`,
  )
}

function checkJsxElement(node: MdNode): MarkdownSafetyIssue[] {
  const name = node.name
  // A fragment (`<>…</>`) renders its children and nothing else.
  if (name === null || name === undefined) return []
  const tag = `<${name}>`
  if (!COMPONENT_NAME.test(name) && !SAFE_HTML_TAGS.has(name)) {
    return [
      issue(
        node,
        name.includes('.')
          ? `${tag} is not allowed: use a component by its plain name`
          : `${tag} is not allowed: it is not one of the HTML tags a body may use, so use one of the site's components instead`,
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
      issues.push(issue(node, `{…} spread attributes are not allowed on ${tag}`))
      continue
    }
    const attributeName = attribute.name
    const lower = attributeName.toLowerCase()
    if (/^on/.test(lower)) {
      issues.push(issue(node, `${attributeName} on ${tag} is not allowed: event handlers run code`))
      continue
    }
    if (FORBIDDEN_ATTRIBUTES.has(lower)) {
      issues.push(issue(node, `${attributeName} on ${tag} is not allowed`))
      continue
    }
    const value = attribute.value
    const isUrl = URL_ATTRIBUTES.has(lower.replace(/[^a-z]/g, ''))
    if (isRecord(value)) {
      if (isUrl) {
        issues.push(issue(node, `${attributeName} on ${tag} must be a plain "string"`))
      } else if (!isInertProgram(estreeOf(value))) {
        issues.push(
          issue(node, `${attributeName} on ${tag} must be a plain value, such as "text" or {300}`),
        )
      }
      continue
    }
    if (isUrl && typeof value === 'string') {
      const urls = lower === 'srcset' ? srcsetUrls(value) : [value]
      for (const url of urls) {
        const found = urlIssue(node, url, `${attributeName} on ${tag}`)
        if (found) issues.push(found)
      }
    }
  }
  return issues
}

function checkNode(node: MdNode, dialect: MarkdownDialect): MarkdownSafetyIssue[] {
  const issues: MarkdownSafetyIssue[] = []
  switch (node.type) {
    case 'mdxjsEsm':
      issues.push(issue(node, 'import/export statements are not allowed: they run as code'))
      break
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
      if (!isInertProgram(estreeOf(node))) {
        issues.push(
          issue(
            node,
            '{…} expressions are not allowed: they run as code. A comment {/* … */} or a plain value such as {" "} is fine',
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
      const found = node.url === undefined ? undefined : urlIssue(node, node.url, `a ${node.type}`)
      if (found) issues.push(found)
      break
    }
  }
  for (const child of node.children ?? []) issues.push(...checkNode(child, dialect))
  return issues
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
  const issues: MarkdownSafetyIssue[] = []
  const seen = new Set<string>()
  for (const withGfm of [false, true]) {
    let tree: MdNode
    try {
      tree = parse(source, dialect, withGfm)
    } catch (err: unknown) {
      return [
        { message: `This MDX does not parse, so it cannot be checked: ${getErrorMessage(err)}` },
      ]
    }
    for (const found of checkNode(tree, dialect)) {
      if (seen.has(found.message)) continue
      seen.add(found.message)
      issues.push(found)
    }
  }
  return issues
}

/** The field's one error: its first issue, and how many more there are. */
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

function checkValue(
  fieldPath: string,
  value: unknown,
  dialect: MarkdownDialect,
): EntryFieldError[] {
  const values = Array.isArray(value) ? value : [value]
  const errors: EntryFieldError[] = []
  values.forEach((item, index) => {
    if (typeof item !== 'string' || item === '') return
    const issues = findUnsafeMarkdown(item, dialect)
    if (issues.length === 0) return
    errors.push(toFieldError(Array.isArray(value) ? `${fieldPath}[${index}]` : fieldPath, issues))
  })
  return errors
}

/**
 * The policy's errors for one entry's on-disk-shaped data, the body merged in under the schema's
 * body field name. The body of an `md`/`mdx` entry is checked in the entry's format whatever its
 * field's type, and is checked when the schema declares no body field; it is exempt only when
 * its field is `executable`.
 */
export function validateMarkdownSafety(
  fields: EntrySchema,
  format: ContentFormat | undefined,
  data: Record<string, unknown>,
): EntryFieldError[] {
  const hasBody = format === 'md' || format === 'mdx'
  const bodyName = hasBody ? findBodyFieldName(fields) : undefined
  const errors: EntryFieldError[] = []

  if (hasBody && bodyName !== undefined) {
    const bodyField = flattenGroupFields(fields).find((field) => field.name === bodyName)
    const executable =
      bodyField !== undefined && 'executable' in bodyField && bodyField.executable === true
    if (!executable) errors.push(...checkValue(bodyName, data[bodyName], format))
  }

  errors.push(
    ...traverseFields<EntryFieldError>(fields, data, ({ field, value, path }) => {
      if (path === bodyName) return []
      const dialect = dialectOfField(field)
      return dialect === undefined ? [] : checkValue(path, value, dialect)
    }),
  )
  return errors
}
