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
 * `isImplicitlyOffOrigin` below and `utils/url-prefix.ts`'s `isAbsoluteUrl`.
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
 * (e.g. `utils/url-prefix.ts`'s `isAbsoluteUrl`, for a CDN-hosted `ogImage`) should check that
 * separately and only fall back to this function to catch the spellings that slip past a
 * `startsWith('//')` check.
 */
/**
 * A path segment that is exactly `.` or `..`, in any spelling a URL parser collapses.
 *
 * `%2e` must be covered, not just the literal dot: WHATWG's single-dot and double-dot path
 * segment definitions are case-insensitively percent-decoded, so `/upload/%2e%2e/` collapses in
 * a browser exactly as `/upload/../` does. A literal-only guard reads as complete and is one
 * encoding away from useless — measured before this was widened.
 *
 * Bounded repetition over an alternation of two literals, so no nested quantifier and no
 * backtracking blowup — see `utils/url-prefix.ts`'s `stripTrailingSlashes` for why regex shape
 * is watched in this area. Measured under 1ms on 400KB adversarial inputs.
 */
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|$)/i

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
 * Whether `value` is usable as an adopter-CONFIGURED URL base or endpoint: an absolute
 * `http(s)` URL, or a site-relative path with exactly one leading slash.
 *
 * This is the config-validation counterpart to `sanitizeHref`, which does the same job for
 * untrusted CONTENT. The difference is what happens to a bad value: content is coerced to a
 * fallback so a page still renders, whereas config should fail loudly at parse time — nobody
 * is served by a silently-rewritten deployment setting. The http(s) allowlist itself lives in
 * this file either way, so the two surfaces cannot drift into disagreeing about which schemes
 * are acceptable (that drift is exactly why `utils/url-prefix.ts` exists — see its header).
 *
 * `allowProtocolRelative` exists because the two callers genuinely differ, and the difference
 * is blast radius rather than taste:
 *
 * - A READ-side prefix (`media.publicBaseUrl`, joined onto `/assets/…`) may legitimately be
 *   `//cdn.example.com`. `utils/url-prefix.ts`'s `isAbsoluteUrl` documents that literal
 *   spelling as an intentionally-supported off-site pointer, so rejecting it here would break
 *   a working configuration. A bad value costs a broken `<img>`.
 * - A WRITE-side endpoint (`media.uploadUrl`, where the browser POSTs a presigned upload) must
 *   not be protocol-relative even when spelled literally: such a URL inherits the *editor's*
 *   scheme, so an editor tier reachable over http silently downgrades an upload carrying a live
 *   credential and the user's file bytes to plaintext. A bad value costs those.
 *
 * Every other off-origin spelling — `/\host`, `\\host`, `\/host`, `///host` — is rejected for
 * both, in both modes. Those read as site-relative to a human and to a naive `startsWith('/')`
 * check, but WHATWG URL resolves each of them to a different authority (measured: `///x`
 * resolves to host `x`, not to pathname `/x`), so they are never what an adopter meant.
 */
export function isHttpUrlOrSameOriginPath(
  value: string,
  opts: { allowProtocolRelative?: boolean } = {},
): boolean {
  if (value === '') return false

  // Reject ASCII control characters and spaces ANYWHERE in the value, not only at the edges.
  // WHATWG URL strips tab/CR/LF during parsing wherever they occur, so `/\tx` parses as a
  // perfectly ordinary same-origin path and would satisfy every check below — while the
  // browser actually requests `/x`. A stored config value that does not describe what is sent
  // is a defect even when it happens to work, so reject it rather than normalize it away.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f) return false
  }

  // A query or fragment is meaningless on both sides this predicate serves. S3's POST Object
  // takes no query parameters and a browser never transmits a fragment; and on the read side a
  // prefix carrying either produces `https://cdn.example.com/?x=1/assets/…` once joined.
  if (value.includes('?') || value.includes('#')) return false

  // A backslash is never legitimate in a configured URL, and it is not merely cosmetic: WHATWG
  // treats it as a path separator for special schemes, so `/asset\upload/` is SENT as
  // `/asset/upload/`. Worse on the read side, where the value becomes a prefix — `/\` is a
  // string `new URL()` REJECTS, so it slips past the off-origin check below and joins into
  // `/\/assets/a.png`, which a browser then resolves to `https://assets/` (measured). Anyone
  // wanting a literal backslash in a path must percent-encode it.
  if (value.includes('\\')) return false

  // Dot segments resolve away before the request is sent — `/asset-upload/..` is SENT as `/`
  // and `/./x` as `/x` — so the stored value again fails to describe what happens.
  if (DOT_SEGMENT.test(value)) return false

  if (declaresScheme(value)) {
    // The scheme must be followed by a literal `//`. Parsing to an http(s) URL is NOT enough:
    // WHATWG resolves a same-scheme reference carrying no authority as RELATIVE, so a browser
    // on `https://editor.example.com/admin/media` sends `https:cdn.example.com` to
    // `https://editor.example.com/admin/cdn.example.com` — while `new URL()` here would report
    // `https://cdn.example.com/`. Accepting it would post the presigned credential and the
    // user's bytes to a page-dependent path on the editor's own origin, surfacing only as a
    // 404 with nothing pointing at the config. Dropping the `//` is an ordinary typo.
    if (!/^https?:\/\//i.test(value)) return false
    // `http:` is deliberately allowed alongside `https:`: a local S3-compatible endpoint
    // (MinIO, LocalStack) is `http://localhost:9000`, and that is the one setup in which an
    // adopter would most want to exercise this path before deploying.
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  }

  // A LITERAL `//host` is the only off-origin spelling that can be intentional, and only for
  // callers that opt in. `value[2] !== '/'` matters: `///x` and `////x` are also "implicitly
  // off-origin" and also start with `//`, but resolve to a host named `x` rather than to a
  // path — so they must not ride in on the opt-in.
  if (isImplicitlyOffOrigin(value)) {
    return opts.allowProtocolRelative === true && value.startsWith('//') && value[2] !== '/'
  }

  // Site-relative, with exactly one leading slash. The second clause also covers `//`, which
  // `isImplicitlyOffOrigin` reports as false only because `new URL('//', base)` throws.
  return value.startsWith('/') && value[1] !== '/'
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
