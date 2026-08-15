// Fixed sentinel base so relative references (root-relative, path-relative,
// fragment-only, query-only) resolve instead of throwing under `new URL()`.
// Never exposed in output - see the relative-reference branch below.
const SENTINEL_BASE = 'https://relative.invalid'

/**
 * Whether `url` declares an explicit scheme (`https:`, `mailto:`, `javascript:`, ...).
 *
 * This is the property that actually distinguishes "the author asked for another origin" from
 * "the parser inferred one" -- see `sanitizeHref`'s doc for why a `startsWith('//')` /
 * `startsWith('scheme://')` check is not sufficient on its own (WHATWG URL treats backslash as
 * equivalent to forward slash for special schemes, so `/\evil.com`, `\\evil.com` and `\/evil.com`
 * are all protocol-relative in effect despite declaring no scheme). Exported so every "is this
 * URL off-site" check in the package shares one answer instead of re-deriving it -- see
 * `isImplicitlyOffOrigin` below and `static/seo.ts`'s `isAbsoluteUrl`.
 */
export function declaresScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url.trim())
}

/**
 * Whether `url`, resolved as a URL reference against a fixed sentinel origin, lands on a
 * DIFFERENT origin than the sentinel WITHOUT itself declaring a scheme.
 *
 * True for a literal protocol-relative reference (`//host`) and for every WHATWG
 * backslash-equivalent spelling that a browser resolves the same way (`/\host`, `\\host`,
 * `\/host`, and combinations with stripped whitespace/control characters) -- these all read as
 * "site-relative" to a naive string check but actually redefine the authority. False for a
 * normal site-relative path (`/about`, `docs/guide`) and for a scheme-qualified absolute URL
 * (`declaresScheme` already identifies those as intentionally off-site on their own).
 *
 * Callers that want to treat a LITERAL `//host` as an intentionally-supported off-site pointer
 * (e.g. `static/seo.ts`'s `isAbsoluteUrl`, for a CDN-hosted `ogImage`) should check that
 * separately and only fall back to this function to catch the spellings that slip past a
 * `startsWith('//')` check.
 */
export function isImplicitlyOffOrigin(url: string): boolean {
  if (declaresScheme(url)) return false
  try {
    return new URL(url, SENTINEL_BASE).origin !== SENTINEL_BASE
  } catch {
    return false
  }
}

/**
 * If `url` `isImplicitlyOffOrigin`, discard the authority it spoofed and return just the
 * path/search/hash it resolved to -- e.g. `/\evil.com/x` (which parses to origin
 * `https://evil.com`) becomes `/x`. Otherwise return `url` unchanged.
 *
 * This re-parses with the SAME sentinel technique rather than pattern-matching leading
 * slash/backslash characters: WHATWG URL also strips tabs, newlines, and carriage returns during
 * parsing (wherever they appear, not just at the edges), so `/\t/evil.com` is exactly as
 * off-origin as `/\evil.com` despite having no leading backslash-or-slash run for a regex to
 * find. Re-parsing gets this right for free instead of re-deriving the quirk a second time.
 *
 * Useful for a caller that wants to keep emitting SOME value for an implicitly-off-origin input
 * rather than rejecting it outright (`sanitizeHref` rejects to a fallback instead; see
 * `static/seo.ts`'s `resolveSeoUrl`, which has no fallback concept and must always return a
 * same-origin string).
 */
export function neutralizeImplicitOffOrigin(url: string): string {
  if (!isImplicitlyOffOrigin(url)) return url
  const parsed = new URL(url, SENTINEL_BASE)
  return parsed.pathname + parsed.search + parsed.hash
}

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
 * - Protocol-relative input is rejected rather than resolved onto the
 *   sentinel's `https:` scheme. In a CMS content field, `//host` is far more
 *   likely to be a paste error or an injection attempt than an intentional
 *   protocol-relative link, so we don't let it through as an absolute
 *   off-site URL. This is enforced by checking whether the input DECLARES a
 *   scheme, not by matching a `//` prefix: WHATWG URL treats backslash as
 *   equivalent to slash for special schemes, so `/\evil.com`, `\\evil.com`
 *   and `\/evil.com` are all protocol-relative in effect. An earlier version
 *   of this function checked `startsWith('//')` and let all three through as
 *   `https://evil.com/` -- an open redirect out of the one function whose
 *   job is to prevent exactly that.
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

  try {
    const parsed = new URL(trimmed, SENTINEL_BASE)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback
    }

    // Reject protocol-relative references in EVERY spelling, by testing the
    // property we actually care about rather than by enumerating syntax.
    //
    // A string-prefix check on '//' is not sufficient: WHATWG URL treats a
    // backslash as equivalent to a forward slash for special schemes, so
    // '/\evil.com', '\\evil.com' and '\/evil.com' are all protocol-relative
    // in effect and each resolved to https://evil.com/ while sailing past a
    // startsWith('//') guard. Tabs and newlines are stripped during parsing
    // too, so the set of spellings is not one you can enumerate confidently.
    //
    // The property that actually distinguishes "the author asked for another
    // origin" from "the parser inferred one" is whether the input DECLARES a
    // scheme. If it does not and still resolved off the sentinel, it is
    // protocol-relative however it was written.
    if (parsed.origin !== SENTINEL_BASE && !declaresScheme(trimmed)) return fallback

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
