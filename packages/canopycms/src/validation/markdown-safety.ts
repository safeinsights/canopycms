/**
 * The save-time policy that keeps code out of `markdown` and `mdx` content.
 *
 * MDX compiles `{expressions}`, `import`/`export` and JSX into JavaScript that runs wherever a
 * body renders: a preview with the viewer's session, a server render, a CI build. A body this
 * policy accepts runs only the site's own components. An `mdx` field or body, or a `markdown` one
 * with `renderAs: 'mdx'`, accepts:
 *
 * - no `import`/`export`, and no `{…}` expression except a comment or a static literal
 *   (`{300}`, `{["a", "b"]}`), in text or as an attribute value; no spread attributes;
 * - components by plain name (`<Callout>`, the site's own code) and HTML tags from
 *   `SAFE_HTML_TAGS` only, since a tag is a real element whose attributes need no expression to
 *   run code (`<script>`, `<iframe srcdoc>`);
 * - on an HTML tag, attributes from `SAFE_HTML_ATTRIBUTES` and `aria-*` only; no event handler
 *   (`on…` on a tag, `onX` on a component), `dangerouslySetInnerHTML` or `srcdoc` anywhere;
 * - URLs, in links, images, definitions and URL attributes, that are relative, use a scheme in
 *   `SAFE_URL_SCHEMES`, or are raster `data:` images; no `javascript:` or `vbscript:` value in any
 *   prop. React 18 renders a `javascript:` href as given.
 *
 * An `mdxAllow` allowlist (`mdx-allowlist.ts`) narrows this further. Other markdown renders braces
 * and imports as text and runs no tag without raw HTML, so only its URLs are checked; a field with
 * `executable: true` is not checked. A body is parsed with and without GFM, so `remark-gfm` cannot
 * hide a construct; an MDX body that does not parse cannot be checked, so is refused.
 *
 * A save keeps code the stored entry already holds (from outside the CMS, or from before this
 * policy) only in a field saved unchanged: code reads what surrounds it (the props beside it, its
 * parent, the markup a script reads), so no smaller unit is safe to keep. Other fields stay
 * editable, and removing the code is always accepted.
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mdxFromMarkdown } from 'mdast-util-mdx'
import { gfm } from 'micromark-extension-gfm'
import { mdxjs } from 'micromark-extension-mdxjs'

import type { ContentFormat, EntrySchema, FieldConfig, MdxAllowlist } from '../config'
import { findBodyFieldName } from '../utils/body-field'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { getErrorMessage } from '../utils/error'
import type { EntryFieldError } from './entry-validator'
import { traverseFields } from './field-traversal'
import {
  FORBIDDEN_ATTRIBUTES,
  SAFE_HTML_TAGS,
  isComponentName,
  isMarkdownField,
  resolveMdxAllowlist,
} from './mdx-allowlist'
import type { ResolvedMdxAllowlist } from './mdx-allowlist'

type MarkdownDialect = 'md' | 'mdx'

interface MarkdownSafetyIssue {
  message: string
  /** 1-based line in the checked source, when known. */
  line?: number
  /** What a stored issue must match to be kept: its dialect and whole field. None: never kept. */
  key?: string
}

/** One field's issues. */
export interface MarkdownSafetyFinding {
  fieldPath: string
  issues: MarkdownSafetyIssue[]
}

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

/**
 * Attributes, lower-cased, that `SAFE_HTML_TAGS` may carry, plus any `aria-*`. Anything else is
 * refused on a tag, because a script the site loads can give an attribute meaning: Alpine's
 * `x-init`, htmx's `hx-on:click`, or a `data-*` a page script `eval`s.
 */
const SAFE_HTML_ATTRIBUTES = new Set([
  'abbr',
  'align',
  'alt',
  'autoplay',
  'cite',
  'class',
  'classname',
  'colspan',
  'controls',
  'datetime',
  'decoding',
  'default',
  'dir',
  'download',
  'headers',
  'height',
  'hidden',
  'href',
  'hreflang',
  'id',
  'kind',
  'label',
  'lang',
  'loading',
  'loop',
  'media',
  'muted',
  'open',
  'playsinline',
  'poster',
  'preload',
  'rel',
  'reversed',
  'role',
  'rowspan',
  'scope',
  'sizes',
  'span',
  'src',
  'srclang',
  'srcset',
  'start',
  'style',
  'target',
  'title',
  'translate',
  'type',
  'valign',
  'value',
  'width',
])

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

/** The URLs and script schemes in one attribute value, which the base policy refuses. */
function attributeValueIssues(
  node: MdNode,
  tag: string,
  attributeName: string,
  value: unknown,
): MarkdownSafetyIssue[] {
  const lower = attributeName.toLowerCase()
  const isUrl = URL_ATTRIBUTES.has(lower.replace(/[^a-z]/g, ''))
  if (isRecord(value) && (isUrl || !isInertProgram(estreeOf(value)))) {
    return [
      issue(
        node,
        isUrl
          ? `${attributeName} on ${tag} must be a plain "string"`
          : `${attributeName} on ${tag} must be a plain value, such as "text" or {300}`,
      ),
    ]
  }
  if (isUrl && typeof value === 'string') {
    const urls = lower === 'srcset' ? srcsetUrls(value) : [value]
    return urls.flatMap((url) => urlIssue(node, url, `${attributeName} on ${tag}`) ?? [])
  }
  const strings =
    typeof value === 'string' ? [value] : isRecord(value) ? staticStrings(estreeOf(value)) : []
  return strings.flatMap((text) => {
    const scheme = scriptScheme(text)
    return scheme === undefined
      ? []
      : [issue(node, `The URL scheme "${scheme}:" is not allowed in ${attributeName} on ${tag}`)]
  })
}

/**
 * The value an allowlist's value list matches: a string, `true` for a bare attribute, or a
 * single literal expression. Undefined for anything else, which no list matches.
 */
function plainValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value
  const estree = isRecord(value) ? estreeOf(value) : undefined
  if (!isRecord(estree) || !Array.isArray(estree.body) || estree.body.length !== 1) return undefined
  const [statement] = estree.body
  if (!isRecord(statement) || statement.type !== 'ExpressionStatement') return undefined
  const expression = statement.expression
  if (!isRecord(expression) || expression.type !== 'Literal') return undefined
  const literal = expression.value
  return typeof literal === 'string' || typeof literal === 'number' || typeof literal === 'boolean'
    ? literal
    : undefined
}

/** How a refusal shows an attribute as written. */
function showAttribute(attributeName: string, value: unknown): string {
  if (value === null || value === undefined) return attributeName
  if (typeof value === 'string') return `${attributeName}="${value}"`
  return `${attributeName}={…}`
}

const listOf = (names: Iterable<string>) => [...names].sort().join(', ')

function checkJsxElement(node: MdNode, allow: ResolvedMdxAllowlist): MarkdownSafetyIssue[] {
  const name = node.name
  // A fragment (`<>…</>`) renders its children and nothing else.
  if (name === null || name === undefined) {
    return allow.fragments ? [] : [issue(node, 'Fragments (<>…</>) are not allowed here')]
  }
  const tag = `<${name}>`
  const isComponent = isComponentName(name)
  if (!isComponent && !SAFE_HTML_TAGS.has(name)) {
    return [
      issue(
        node,
        name.includes('.')
          ? `${tag} is not allowed: use a component by its plain name`
          : `${tag} is not allowed: it is not one of the HTML tags a body may use, so use one of the site's components instead`,
      ),
    ]
  }
  if (!isComponent && !allow.htmlTags.has(name)) {
    const allowed = allow.htmlTags.size === 0 ? 'none' : listOf(allow.htmlTags)
    return [issue(node, `${tag} is not allowed here; allowed HTML tags: ${allowed}`)]
  }
  if (isComponent && allow.components !== undefined && !allow.components.has(name)) {
    return [
      issue(
        node,
        allow.components.size === 0
          ? `Component ${tag} is not allowed: no components are allowed here`
          : `Component ${tag} is not allowed here; allowed: ${listOf(allow.components.keys())}`,
      ),
    ]
  }
  const props = isComponent ? allow.components?.get(name) : undefined
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
    const value = attribute.value
    const lower = attributeName.toLowerCase()
    if (props !== undefined && !props.has(attributeName)) {
      issues.push(
        issue(
          node,
          props.size === 0
            ? `Prop ${attributeName} on ${tag} is not allowed: ${tag} takes no props here`
            : `Prop ${attributeName} on ${tag} is not allowed here; allowed: ${listOf(props.keys())}`,
        ),
      )
      continue
    }
    // A tag's `on…` attribute is a handler in any spelling; a component's prop is one by React's
    // convention, so `online` or `onlyMobile` stays a plain prop.
    if (isComponent ? /^on[A-Z]/.test(attributeName) : /^on/.test(lower)) {
      issues.push(issue(node, `${attributeName} on ${tag} is not allowed: event handlers run code`))
      continue
    }
    if (
      FORBIDDEN_ATTRIBUTES.has(lower) ||
      (!isComponent && !SAFE_HTML_ATTRIBUTES.has(lower) && !lower.startsWith('aria-'))
    ) {
      issues.push(issue(node, `${attributeName} on ${tag} is not allowed`))
      continue
    }
    if (isRecord(value) && !allow.expressions) {
      issues.push(
        issue(
          node,
          `${attributeName} on ${tag} must be a plain "string": {…} values are not allowed here`,
        ),
      )
      continue
    }
    const found = attributeValueIssues(node, tag, attributeName, value)
    if (found.length > 0) {
      issues.push(...found)
      continue
    }
    const values = props?.get(attributeName)
    if (Array.isArray(values)) {
      const plain = plainValue(value)
      if (plain === undefined || !values.includes(plain)) {
        const allowed = values.map((v) => JSON.stringify(v)).join(', ')
        issues.push(
          issue(
            node,
            `${showAttribute(attributeName, value)} on ${tag} is not allowed here; allowed values: ${allowed}`,
          ),
        )
      }
    }
  }
  return issues
}

function checkNode(
  node: MdNode,
  definitions: ReadonlyMap<string, string>,
  allow: ResolvedMdxAllowlist,
): MarkdownSafetyIssue[] {
  const issues: MarkdownSafetyIssue[] = []
  switch (node.type) {
    case 'mdxjsEsm':
      issues.push(issue(node, 'import/export statements are not allowed: they run as code'))
      break
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
      if (!allow.expressions) {
        issues.push(
          issue(node, '{…} expressions are not allowed here, not even comments or plain values'),
        )
      } else if (!isInertProgram(estreeOf(node))) {
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
      issues.push(...checkJsxElement(node, allow))
      break
    case 'link':
    case 'image':
    case 'definition': {
      const found =
        node.url === undefined ? undefined : urlIssue(node, node.url, URL_SITES[node.type] ?? '')
      if (found) issues.push(found)
      break
    }
    // A reference loads its definition's URL.
    case 'linkReference':
    case 'imageReference': {
      const url = node.identifier === undefined ? undefined : definitions.get(node.identifier)
      const found = url === undefined ? undefined : urlIssue(node, url, URL_SITES[node.type] ?? '')
      if (found) issues.push(found)
      break
    }
  }
  for (const child of node.children ?? []) issues.push(...checkNode(child, definitions, allow))
  return issues
}

/** How an issue names each node that carries a URL. */
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
  allow: ResolvedMdxAllowlist = resolveMdxAllowlist(undefined, undefined),
): MarkdownSafetyIssue[] {
  // Line endings are not part of what MDX compiles, and a save may turn CRLF into LF.
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
      found = checkNode(tree, collectDefinitions(tree), allow)
    } catch (err: unknown) {
      // Nesting deep enough to exhaust the stack.
      return [{ message: `This body is too deeply nested to check: ${getErrorMessage(err)}` }]
    }
    parses.push(found)
  }
  // Both parses report most constructs; each is reported as often as the parse that saw it most.
  const id = (item: MarkdownSafetyIssue) => item.message
  const [plain = [], withGfm = []] = parses
  const unmatched = new Map<string, number>()
  for (const item of plain) unmatched.set(id(item), (unmatched.get(id(item)) ?? 0) + 1)
  const issues = [...plain]
  for (const item of withGfm) {
    const count = unmatched.get(id(item)) ?? 0
    if (count > 0) unmatched.set(id(item), count - 1)
    else issues.push(item)
  }
  // The same text runs differently as markdown and as MDX, so the dialect is part of the key.
  const key = `${dialect}\0${field}`
  return issues.map((item) => ({ ...item, key }))
}

/** The field's one message: its first issue, and how many more there are. */
function toFieldError(fieldPath: string, issues: MarkdownSafetyIssue[]): EntryFieldError {
  const [first, ...rest] = issues
  const more = rest.length === 0 ? '' : ` (and ${rest.length} more)`
  return { fieldPath, message: `${first?.message ?? ''}${more}` }
}

/** How one field is checked: as markdown or MDX, and what MDX it accepts. */
interface FieldPolicy {
  dialect: MarkdownDialect
  allow: ResolvedMdxAllowlist
}

function policyOfField(
  field: FieldConfig,
  site: MdxAllowlist | undefined,
): FieldPolicy | undefined {
  if (!isMarkdownField(field) || field.executable === true) return undefined
  return {
    dialect: field.type === 'mdx' || field.renderAs === 'mdx' ? 'mdx' : 'md',
    allow: resolveMdxAllowlist(field.mdxAllow, site),
  }
}

function findInValue(
  fieldPath: string,
  value: unknown,
  { dialect, allow }: FieldPolicy,
): MarkdownSafetyFinding[] {
  const values = Array.isArray(value) ? value : [value]
  const findings: MarkdownSafetyFinding[] = []
  values.forEach((item, index) => {
    if (typeof item !== 'string' || item === '') return
    const issues = findUnsafeMarkdown(item, dialect, allow)
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
 * body field name. The body of an `mdx` entry is MDX whatever its field's type; the body of an
 * `md` entry is MDX only when its field sets `renderAs: 'mdx'`. The body is checked when the
 * schema declares no body field, and is exempt only when its field is `executable`. `siteAllow`
 * is the config's `mdxAllow`, under each field's own.
 */
export function findMarkdownSafetyIssues(
  fields: EntrySchema,
  format: ContentFormat | undefined,
  data: Record<string, unknown>,
  siteAllow?: MdxAllowlist,
): MarkdownSafetyFinding[] {
  const hasBody = format === 'md' || format === 'mdx'
  const bodyName = hasBody ? findBodyFieldName(fields) : undefined
  const findings: MarkdownSafetyFinding[] = []

  if (hasBody && bodyName !== undefined) {
    const found = flattenGroupFields(fields).find((field) => field.name === bodyName)
    const bodyField = found !== undefined && isMarkdownField(found) ? found : undefined
    if (bodyField?.executable !== true) {
      const policy: FieldPolicy = {
        dialect: format === 'mdx' || bodyField?.renderAs === 'mdx' ? 'mdx' : 'md',
        allow: resolveMdxAllowlist(bodyField?.mdxAllow, siteAllow),
      }
      findings.push(...findInValue(bodyName, data[bodyName], policy))
    }
  }

  findings.push(
    ...traverseFields<MarkdownSafetyFinding>(fields, data, ({ field, value, path }) => {
      if (path === bodyName) return []
      const policy = policyOfField(field, siteAllow)
      return policy === undefined ? [] : findInValue(path, value, policy)
    }),
  )
  return findings
}

/** A field with list and block positions dropped, so reordering items keeps a match. */
const site = (fieldPath: string) => fieldPath.replace(/\[\d+\]/g, '')

/**
 * Splits a save's issues into those it adds, which refuse it, and those of a field saved exactly as
 * the stored entry held it, which it keeps. Issues are matched by key and counted, so a second copy
 * of a stored field is refused, as is one moved to a field of another name. An issue with no key,
 * such as a body that does not parse, is never kept.
 */
export function splitByStored(
  found: readonly MarkdownSafetyFinding[],
  stored: readonly MarkdownSafetyFinding[],
): { refused: EntryFieldError[]; kept: EntryFieldError[] } {
  const available = new Map<string, number>()
  const storedSites = new Set(stored.map((finding) => site(finding.fieldPath)))
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
    if (added.length > 0) {
      const error = toFieldError(finding.fieldPath, added)
      refused.push(
        storedSites.has(site(finding.fieldPath))
          ? {
              ...error,
              message: `This field already holds content it refuses, so it saves only unchanged or with that content removed. ${error.message}`,
            }
          : error,
      )
    }
    if (held.length > 0) kept.push(toFieldError(finding.fieldPath, held))
  }
  return { refused, kept }
}
