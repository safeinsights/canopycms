/**
 * Joining a URL prefix onto a root-relative path, in ONE place.
 *
 * Two surfaces need the identical operation and had drifted into two implementations:
 *
 * - `static/seo.ts`'s `resolveSeoUrl` puts a site origin in front of an entry's URL path.
 * - `assets/asset-url.ts`'s `assetUrl` puts an asset-space mount point in front of a stored
 *   `/assets/…` src.
 *
 * The asset copy was the weaker one - it checked neither absoluteness of the path nor the shape
 * of the prefix - so it silently produced `/prefix/https://cdn.example.com/x.png` for an
 * off-site src, and a *document-relative* URL for a prefix that had no leading slash. Both bugs
 * were already solved on the SEO side. Sharing one function is what stops a third caller from
 * inheriting the weaker half again.
 *
 * Dependency-free apart from `./sanitize-href` (itself pure - its only dependency is the global
 * `URL`), because this is reachable from client bundles via `assets/asset-url.ts`. Do not add a
 * node built-in here; `pnpm lint:bundle` fails the build if you do.
 */

import { declaresScheme, neutralizeImplicitOffOrigin } from './sanitize-href'

/**
 * Whether `url` is a DECLARED off-site pointer - a scheme-qualified absolute URL
 * (`https://example.com/x`) or a literal protocol-relative one (`//cdn.example.com/x`).
 *
 * Deliberately narrower than "resolves off-origin": a WHATWG-backslash-equivalent spelling
 * (`/\evil.com`, `\\evil.com`, `\/evil.com` — see `utils/sanitize-href.ts`'s
 * `isImplicitlyOffOrigin`) also resolves off-origin in a browser, but is NOT recognized here as
 * an intentional off-site pointer the way a literal `//cdn…` is. Callers handle that case
 * separately, by neutralizing (`neutralizeImplicitOffOrigin`) rather than passing through: a
 * `false` result here isn't a guarantee the value is a safe site-relative path on its own, only
 * that it isn't a *declared* off-site one.
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith('//')
}

/**
 * Strip trailing slashes without a regex.
 *
 * The obvious `replace(/\/+$/, '')` is a polynomial-ReDoS shape (CodeQL
 * `js/polynomial-redos`, flagged high): on a value that is mostly slashes but does not end in
 * one, the engine retries `\/+` from every position and the match cost is quadratic in the
 * input length. Both prefixes that reach here - a `siteUrl` and an asset `baseUrl` - are
 * adopter-supplied and can come from config or an env var, so they count as uncontrolled. A
 * character scan is linear and needs no reasoning about backtracking.
 *
 * Exported (from `canopycms/server`) so adopter code normalizing its own site-origin env var —
 * e.g. a `SITE_URL` constant built from `NEXT_PUBLIC_SITE_URL` — has a package-provided linear
 * way to do it instead of reaching for the same regex this function replaced.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--
  return value.slice(0, end)
}

/**
 * Reduce a URL reference to a value that is safe to emit as a SAME-ORIGIN path.
 *
 * `neutralizeImplicitOffOrigin` alone is not sufficient, and this is the subtle part: it returns
 * `pathname + search + hash`, and a WHATWG `pathname` can ITSELF begin with `//`. `/\evil.com//a`
 * parses to host `evil.com` with pathname `//a`, so neutralizing yields the string `//a` — which,
 * re-emitted as a URL reference, reads as protocol-relative all over again and points at a host
 * literally named `a`. Neutralizing a second time does not help: the value is now indistinguishable
 * from a caller's legitimate `//cdn.example.com` pointer, so every absolute-URL check downstream
 * (correctly) passes it straight through, prefix and all.
 *
 * The value is same-origin by construction at this point, so collapse the leading slash run to a
 * single slash. Linear scan rather than a regex, for the reason `stripTrailingSlashes` documents.
 *
 * Use this instead of calling `neutralizeImplicitOffOrigin` directly anywhere the result is going
 * to be prefixed or emitted as a path.
 */
export function toSameOriginPath(url: string): string {
  const neutralized = neutralizeImplicitOffOrigin(url)
  let slashes = 0
  while (slashes < neutralized.length && neutralized.charCodeAt(slashes) === 47 /* '/' */) slashes++
  return slashes > 1 ? `/${neutralized.slice(slashes)}` : neutralized
}

/**
 * Make `url` safe to emit AS-IS, changing nothing else.
 *
 * The safety half of `joinUrlPrefix`, without the prefixing or the leading-slash rooting - for a
 * caller that has no mount point to apply and must hand a value back byte-identical wherever it
 * legitimately can. Two kinds pass through untouched:
 *
 * - **Scheme-bearing** (`data:`, `blob:`, `mailto:`, `https://…`). Not a site-relative path, so
 *   rooting it just corrupts it (`data:image/png;…` → `/data:image/png;…`, a broken `<img src>`).
 *   Whether a given scheme is SAFE to render is a separate question that belongs to the caller -
 *   see `sanitize-href.ts`'s `sanitizeHref` for href contexts.
 * - **Literal protocol-relative** (`//cdn.example.com/x`), an intentionally-supported off-site
 *   pointer.
 *
 * Everything else goes through `toSameOriginPath`, so a value that merely *reads* as off-origin to
 * a browser (the backslash spellings) is still neutralized rather than passed along.
 */
export function sanitizeUnprefixedPath(url: string): string {
  if (declaresScheme(url) || isAbsoluteUrl(url)) return url
  return toSameOriginPath(url)
}

/**
 * Put `prefix` in front of the root-relative `path`, and return `path` untouched when it is
 * already a declared off-site URL.
 *
 * ORDER MATTERS — the absolute check on `path` runs FIRST. An absolute or protocol-relative
 * value is a deliberate off-site pointer (syndication, a partner-hosted copy, a CDN image) and
 * must pass through verbatim; prefixing first turns `https://other.org/page` into
 * `<prefix>/https://other.org/page`.
 *
 * `prefix` normalization, in order:
 * - Empty/undefined, or nothing but slashes (`'/'`, `'///'`) → no prefix at all, so the result
 *   stays root-relative. This is what makes an unset option a clean no-op. It also kills a
 *   `'//'` prefix, which would otherwise concatenate to `//assets/…` — read by browsers as
 *   protocol-relative, i.e. a request to a host literally named `assets`.
 * - A declared off-site prefix (`https://cdn.example.com`, `//cdn.example.com`) is used as-is.
 *   A literal protocol-relative prefix is an intentionally-supported off-site pointer here (see
 *   `utils/sanitize-href.ts`), so it is NOT collapsed to a path.
 * - Anything else is a same-origin path prefix and is given a leading slash if it lacks one.
 *   Without this, a prefix like `preview-123` (the shape an env var often carries) produces a
 *   *document-relative* URL that resolves to a different place on every page — an intermittent
 *   failure that is harder to diagnose than the plain 404 it replaced.
 *
 * `path` is run through `toSameOriginPath` when it is not a pass-through, so a
 * backslash-equivalent spelling that `isAbsoluteUrl` correctly declines to call "absolute"
 * (see its doc) can't still be read by a browser as protocol-relative once emitted. Note this
 * needs the `//`-pathname collapse, not just neutralization — see `toSameOriginPath`.
 *
 * `prefix` is NOT neutralized: it is adopter-supplied configuration rather than content, and
 * neutralizing it would silently rewrite a legitimate protocol-relative CDN base into a path.
 */
export function joinUrlPrefix(prefix: string | undefined, path: string): string {
  const safePath = sanitizeUnprefixedPath(path)
  // Pass-throughs are returned verbatim: there is no meaningful way to prefix them.
  if (declaresScheme(safePath) || isAbsoluteUrl(safePath)) return safePath

  const normalizedPath = safePath.startsWith('/') ? safePath : `/${safePath}`

  if (!prefix) return normalizedPath
  const trimmedPrefix = stripTrailingSlashes(prefix)
  if (!trimmedPrefix) return normalizedPath

  const normalizedPrefix =
    isAbsoluteUrl(trimmedPrefix) || trimmedPrefix.startsWith('/')
      ? trimmedPrefix
      : `/${trimmedPrefix}`

  return `${normalizedPrefix}${normalizedPath}`
}
