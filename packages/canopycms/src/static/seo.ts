/**
 * Framework-agnostic SEO field extraction and URL shaping.
 *
 * This module is pure: it maps an entry's raw data onto a neutral `SeoFields` shape and
 * resolves URLs. Framework adapters (e.g. canopycms-next's `entryToMetadata`) turn that shape
 * into their own metadata objects; nothing here imports a framework or a node built-in.
 *
 * The field names default to the recommended SEO field group — see `defineSeoFieldGroup` in
 * entry-schema.ts, which builds a schema group from these same names so the schema side and
 * the read side cannot drift.
 */

/** og:type values covered by the recommended group. */
export type SeoOgType = 'website' | 'article' | 'profile'

/** twitter:card values covered by the recommended group. */
export type SeoTwitterCard = 'summary' | 'summary_large_image'

/** The neutral, framework-agnostic SEO shape. */
export interface SeoFields {
  title?: string
  description?: string
  ogImage?: string
  ogType?: SeoOgType
  canonical?: string
  noindex?: boolean
  twitterCard?: SeoTwitterCard
}

/** Entry field names backing each neutral field. */
export type SeoFieldNames = Record<keyof SeoFields, string>

/**
 * The recommended SEO field names. `defineSeoFieldGroup()` emits a schema group using exactly
 * these names, so an adopter who uses both ends needs no configuration at all.
 */
export const DEFAULT_SEO_FIELD_NAMES = {
  title: 'metaTitle',
  description: 'metaDescription',
  ogImage: 'ogImage',
  ogType: 'ogType',
  canonical: 'canonical',
  noindex: 'noindex',
  twitterCard: 'twitterCard',
} as const satisfies SeoFieldNames

export interface ExtractSeoFieldsOptions {
  /** Per-field name overrides (e.g. `{ title: 'seoTitle' }`). */
  fields?: Partial<SeoFieldNames>
  /**
   * Read the fields from a nested object under this key instead of from flat entry fields.
   * Pair with `defineSeoFieldGroup({ group: 'seo' })`, which nests the same fields under that
   * key in the content file. Omit for the flat (inline-group) convention, which is the default
   * on both ends.
   */
  group?: string
  /** Used when the entry has no meta title (typically the entry's own title/heading). */
  fallbackTitle?: string
  /** Used when the entry has no meta description. */
  fallbackDescription?: string
}

/** Just the parts of `ExtractSeoFieldsOptions` that locate the fields, with no fallbacks. */
export type SeoFieldLocation = Pick<ExtractSeoFieldsOptions, 'fields' | 'group'>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * A non-empty trimmed string, or undefined.
 *
 * Empty is treated as UNSET, deliberately: CanopyCMS writes optional fields present-but-empty
 * rather than omitting them, so `metaTitle: ''` is what an untouched SEO group looks like on
 * disk. Treating it as a value would let a blank field beat the fallback title on every entry
 * whose author never opened the SEO section.
 */
const asText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

const asFlag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

/**
 * An image URL from either convention: a plain string field, or an `image` field, whose value
 * is a structured `{ src, alt, ... }` object. Supporting both means switching the recommended
 * `ogImage` field to `type: 'image'` doesn't silently drop every OG image.
 */
const asImageUrl = (value: unknown): string | undefined => {
  const text = asText(value)
  if (text) return text
  return asText(asRecord(value)?.src)
}

const asOgType = (value: unknown): SeoOgType | undefined => {
  const text = asText(value)
  return text === 'website' || text === 'article' || text === 'profile' ? text : undefined
}

const asTwitterCard = (value: unknown): SeoTwitterCard | undefined => {
  const text = asText(value)
  return text === 'summary' || text === 'summary_large_image' ? text : undefined
}

/**
 * Map an entry's SEO fields onto the neutral shape.
 *
 * Entry data is `unknown` — every read is guarded, unknown enum values are dropped rather than
 * passed through, and non-object data (null, a string, an array) yields an all-undefined result
 * rather than throwing.
 */
export function extractSeoFields(
  entryData: unknown,
  opts: ExtractSeoFieldsOptions = {},
): SeoFields {
  const names = { ...DEFAULT_SEO_FIELD_NAMES, ...opts.fields }
  const entry = asRecord(entryData)
  const source = opts.group ? asRecord(entry?.[opts.group]) : entry

  return {
    title: asText(source?.[names.title]) ?? asText(opts.fallbackTitle),
    description: asText(source?.[names.description]) ?? asText(opts.fallbackDescription),
    ogImage: asImageUrl(source?.[names.ogImage]),
    ogType: asOgType(source?.[names.ogType]),
    canonical: asText(source?.[names.canonical]),
    noindex: asFlag(source?.[names.noindex]),
    twitterCard: asTwitterCard(source?.[names.twitterCard]),
  }
}

/**
 * THE `noindex` predicate. Every surface that suppresses an entry must route through this one
 * function rather than re-deriving the flag:
 *
 * - the page's own `robots: { index: false }` (canopycms-next's `entryToMetadata`), and
 * - exclusion from the sitemap (canopycms-next's `generateContentSitemap`).
 *
 * Those two shipping from one predicate is the point of shipping them together. Where they were
 * derived separately, a `noindex` entry stayed advertised in one surface while correctly absent
 * from the other, and nothing warned.
 *
 * NOT applied to enumeration: `noindex` means "don't advertise this", not "don't build this".
 * `collectRoutableEntries` and `generateStaticParams` must still emit the entry, so its URL
 * resolves for anyone holding the link.
 */
export function isNoindexEntry(entryData: unknown, opts: SeoFieldLocation = {}): boolean {
  return extractSeoFields(entryData, opts).noindex === true
}

/**
 * An off-site URL: either scheme-qualified (`https://…`) or protocol-relative (`//cdn…`).
 * Both name a host we don't control, so neither may be rewritten against the site origin.
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith('//')
}

/**
 * Append a trailing slash to a site-relative path, matching a site that serves `/contact/`.
 *
 * Leaves the root (`/`) and file-like paths (a last segment containing a dot, e.g.
 * `/blog/rss.xml`) alone, and never doubles an existing slash.
 *
 * A query string and/or fragment (`?page=2`, `#section`) is split off BEFORE the slash decision
 * and placement, then reattached after — so `/blog?page=2` becomes `/blog/?page=2`, never
 * `/blog?page=2/` (a literal trailing slash inside the query string, which is not what "serve
 * with a trailing slash" means and breaks the URL).
 */
/**
 * Strip trailing slashes without a regex.
 *
 * The obvious `replace(/\/+$/, '')` is a polynomial-ReDoS shape (CodeQL
 * `js/polynomial-redos`, flagged high): on a value that is mostly slashes but does not end in
 * one, the engine retries `\/+` from every position and the match cost is quadratic in the
 * input length. `siteUrl` is adopter-supplied and can reach here from config or an env var, so
 * it counts as uncontrolled. A character scan is linear and needs no reasoning about
 * backtracking.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--
  return value.slice(0, end)
}

export function withTrailingSlash(path: string): string {
  const splitIndex = path.search(/[?#]/)
  const base = splitIndex === -1 ? path : path.slice(0, splitIndex)
  const suffix = splitIndex === -1 ? '' : path.slice(splitIndex)

  const withLeading = base.startsWith('/') ? base : `/${base}`
  if (withLeading === '/' || withLeading.endsWith('/')) return withLeading + suffix
  const lastSegment = withLeading.slice(withLeading.lastIndexOf('/') + 1)
  if (lastSegment.includes('.')) return withLeading + suffix
  return `${withLeading}/${suffix}`
}

export interface ResolveSeoUrlOptions {
  /** Site origin (e.g. `https://example.com`). Trailing slashes are stripped. */
  siteUrl?: string
  /**
   * Emit site-relative paths with a trailing slash. CanopyCMS has no knowledge of your
   * framework's routing config, so this must be stated explicitly — see the note on
   * `generateContentSitemap`.
   */
  trailingSlash?: boolean
}

/**
 * Resolve a possibly-relative URL for public emission (canonical tag, sitemap URL, OG image).
 *
 * ORDER MATTERS — the absolute check runs FIRST. An absolute or protocol-relative value is a
 * deliberate off-site pointer (syndication, a partner-hosted copy, a CDN image) and passes
 * through verbatim; only a site-relative path gets trailing-slash normalization and the site
 * origin. Normalizing first turns `https://other.org/page` into
 * `<siteUrl>/https://other.org/page/`.
 *
 * With no `siteUrl`, a site-relative path is returned still relative (normalized), which is
 * what you want when the framework resolves relative metadata URLs itself.
 */
export function resolveSeoUrl(pathOrUrl: string, opts: ResolveSeoUrlOptions = {}): string {
  if (isAbsoluteUrl(pathOrUrl)) return pathOrUrl
  const normalized = opts.trailingSlash
    ? withTrailingSlash(pathOrUrl)
    : pathOrUrl.startsWith('/')
      ? pathOrUrl
      : `/${pathOrUrl}`
  const origin = opts.siteUrl === undefined ? undefined : stripTrailingSlashes(opts.siteUrl)
  return origin ? origin + normalized : normalized
}
