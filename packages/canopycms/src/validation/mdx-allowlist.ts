/**
 * What an MDX body may hold, as `markdown-safety.ts` enforces it and as config validation and
 * the editor read it. Dependency-free, so config schemas and the client bundle can import it
 * without the MDX parser.
 *
 * An `MdxAllowlist` only narrows the base policy: a tag outside `SAFE_HTML_TAGS`, a name that is
 * not a component, and a prop the base policy refuses are config errors, and every base rule
 * still runs on what the allowlist accepts.
 */

import type { FieldConfig, MarkdownFieldConfig, MdxAllowlist, MdxPropAllow } from '../config/types'

/** HTML tags an MDX body may use: content elements whose attributes carry no code. */
export const SAFE_HTML_TAGS: ReadonlySet<string> = new Set([
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

/**
 * A JSX name MDX resolves from the site's components rather than rendering as an HTML tag. A name
 * led by `_` or `$` could name one of MDX's own bindings, as could the two below.
 */
const COMPONENT_NAME = /^[A-Z][\w$]*$/
const MDX_BINDINGS = new Set(['MDXContent', 'MDXLayout'])

export function isComponentName(name: string): boolean {
  return COMPONENT_NAME.test(name) && !MDX_BINDINGS.has(name)
}

/** Attribute names, lower-cased, that put markup or a document into the page. */
export const FORBIDDEN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'dangerouslysetinnerhtml',
  'srcdoc',
])

/**
 * A component prop the base policy always refuses: an event handler by React's convention
 * (`onClick`, while `online` stays a plain prop), or one in `FORBIDDEN_ATTRIBUTES`.
 */
export function isRefusedComponentProp(name: string): boolean {
  return /^on[A-Z]/.test(name) || FORBIDDEN_ATTRIBUTES.has(name.toLowerCase())
}

/**
 * An allowlist with the defaults filled in. `components` undefined: any component; a component's
 * props undefined: any prop.
 */
export interface ResolvedMdxAllowlist {
  components: ReadonlyMap<string, ReadonlyMap<string, MdxPropAllow> | undefined> | undefined
  htmlTags: ReadonlySet<string>
  expressions: boolean
  fragments: boolean
}

/** Each key the field sets replaces the site's; a key neither sets keeps the base policy. */
export function resolveMdxAllowlist(
  field: MdxAllowlist | undefined,
  site: MdxAllowlist | undefined,
): ResolvedMdxAllowlist {
  const components = field?.components ?? site?.components
  const htmlTags = field?.htmlTags ?? site?.htmlTags
  return {
    components:
      components === undefined
        ? undefined
        : new Map(
            Object.entries(components).map(([name, { props }]) => [
              name,
              props === undefined ? undefined : new Map(Object.entries(props)),
            ]),
          ),
    htmlTags: htmlTags === undefined ? SAFE_HTML_TAGS : new Set(htmlTags),
    expressions: field?.expressions ?? site?.expressions ?? true,
    fragments: field?.fragments ?? site?.fragments ?? true,
  }
}

export function isMarkdownField(field: FieldConfig): field is MarkdownFieldConfig {
  return field.type === 'markdown' || field.type === 'mdx'
}

/**
 * Why a markdown or mdx field's `renderAs`, `mdxAllow` and `executable` contradict each other, or
 * undefined. An allowlist that cannot apply would look like protection it is not.
 */
export function markdownFieldOptionsError(field: MarkdownFieldConfig): string | undefined {
  if (field.renderAs !== undefined && field.type === 'mdx') {
    return `Field "${field.name}": renderAs applies to markdown fields; an mdx field always renders as MDX`
  }
  if (field.mdxAllow === undefined) return undefined
  if (field.executable === true) {
    return `Field "${field.name}": mdxAllow has no effect with executable: true, which turns the check off`
  }
  if (field.type === 'markdown' && field.renderAs !== 'mdx') {
    return `Field "${field.name}": mdxAllow applies to MDX; set renderAs: 'mdx' on a markdown field the site renders as MDX`
  }
  return undefined
}
