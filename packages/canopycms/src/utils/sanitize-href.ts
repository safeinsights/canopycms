// Fixed sentinel base so relative references (root-relative, path-relative,
// fragment-only, query-only) resolve instead of throwing under `new URL()`.
// Never exposed in output - see the relative-reference branch below.
const SENTINEL_BASE = 'https://relative.invalid'

/**
 * Sanitize an untrusted URL for use in `href` attributes.
 *
 * Handles both absolute URLs (`https://example.com`) and relative
 * references (`/about`, `docs/guide`, `#section`, `?q=1`) by parsing
 * against a fixed sentinel base, then only allows `http:` and `https:`
 * protocols, blocking `javascript:`, `data:`, `vbscript:`, and other
 * dangerous schemes (an absolute URL supplies its own protocol regardless
 * of the sentinel). Returns the fallback (default `'#'`) for invalid,
 * empty, or disallowed input.
 *
 * Design decisions (deliberate, not oversights):
 * - Protocol-relative input (`//evil.com/x`) is rejected outright rather
 *   than resolved onto the sentinel's `https:` scheme. In a CMS content
 *   field, `//host` is far more likely to be a paste error or an injection
 *   attempt than an intentional protocol-relative link, so we don't let it
 *   through as an absolute off-site URL.
 * - Fragment-only (`#section`) and query-only (`?q=1`) input resolves
 *   against the sentinel with pathname `/`; we strip that synthetic leading
 *   slash so the result stays a same-page reference (`#section`) instead of
 *   silently becoming a navigation to the site root (`/#section`).
 * - Path-relative input with no leading slash (`docs/guide`) is returned as
 *   a root-relative path (`/docs/guide`). There is no notion of "current
 *   page" at sanitize time, so true path-relative resolution can't be
 *   reproduced faithfully - root-relative is the closest safe behavior.
 *
 * This utility breaks CodeQL's taint chain by constructing a new string from
 * the parsed URL rather than passing the original input through.
 *
 * @example
 * ```tsx
 * import { sanitizeHref } from 'canopycms'
 *
 * <a href={sanitizeHref(cta.link)}>{cta.text}</a>
 * ```
 */
export function sanitizeHref(url: string, fallback = '#'): string {
  const trimmed = url.trim()
  if (trimmed === '') return fallback
  // Reject protocol-relative references outright; see design decisions above.
  if (trimmed.startsWith('//')) return fallback

  try {
    const parsed = new URL(trimmed, SENTINEL_BASE)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback
    }

    if (parsed.origin === SENTINEL_BASE) {
      // Input was relative: return it as a relative reference rather than
      // an absolute URL rebased onto the sentinel host.
      const relative = parsed.pathname + parsed.search + parsed.hash
      // Fragment-only/query-only input resolves with pathname '/'; strip
      // that synthetic leading slash so it stays a same-page reference.
      return parsed.pathname === '/' && !trimmed.startsWith('/') ? relative.slice(1) : relative
    }

    return parsed.href
  } catch {
    // invalid URL
  }
  return fallback
}
