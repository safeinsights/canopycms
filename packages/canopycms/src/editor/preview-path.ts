import { isAbsoluteUrl, joinUrlPrefix, stripTrailingSlashes } from '../utils/url-prefix'

/**
 * The query part that asks a `createPreviewPage` route to render the site's header and footer
 * (`canopycms-next`'s `layout` option). It changes how the page looks, not which page it is.
 */
const SITE_CHROME_PART = 'chrome=1'

/**
 * `search` without the parts `keep` refuses, as `?…`, or '' when none is left. Filtered as text:
 * a URLSearchParams round trip would form-encode the rest (`flag` becomes `flag=`, `%20` `+`).
 */
const filterQuery = (search: string, keep: (part: string) => boolean): string => {
  const query = search
    .slice(1)
    .split('&')
    .filter((part) => part !== '' && keep(part))
    .join('&')
  return query ? `?${query}` : ''
}

/**
 * Reduces a preview URL to what identifies the page, its path and query, with no origin,
 * fragment, trailing slash or `chrome=1`. The editor names a page by the `src` it built and the
 * framed page by its own location. An absolute `src`, a host redirect that adds or drops a
 * trailing slash, or the site header and footer toggle, spells the same page two ways, and the
 * bridge must still match them.
 * @internal Exported for tests.
 */
export const normalizePreviewPath = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url, 'http://preview.invalid')
  } catch {
    return url
  }
  const query = filterQuery(parsed.search, (part) => part !== SITE_CHROME_PART)
  return `${stripTrailingSlashes(parsed.pathname) || '/'}${query}`
}

/** Whether two preview URLs name the same page; see `normalizePreviewPath`. */
export const isSamePreviewPath = (a: string, b: string): boolean =>
  normalizePreviewPath(a) === normalizePreviewPath(b)

/** Where `buildPreviewSrc` mounts the preview routes, and the `basePath` the site's pages keep. */
export interface PreviewMount {
  basePath?: string
  previewPrefix?: string
}

/** The `previewPrefix` mount `url` sits under, and what follows it; `undefined` when not under one. */
const splitPreviewPrefix = (
  url: string,
  { basePath, previewPrefix }: PreviewMount,
): { mount: string; rest: string } | undefined => {
  if (!previewPrefix || !stripTrailingSlashes(previewPrefix)) return undefined
  const mount = stripTrailingSlashes(joinUrlPrefix(basePath, joinUrlPrefix(previewPrefix, '/')))
  if (!url.startsWith(mount)) return undefined
  const rest = url.slice(mount.length)
  return rest === '' || /^[/?#]/.test(rest) ? { mount, rest } : undefined
}

/** `url` with the `previewPrefix` mount taken out, so `/base/preview/posts/x` reads `/base/posts/x`. */
const stripPreviewPrefix = (url: string, previewMount: PreviewMount): string => {
  const split = splitPreviewPrefix(url, previewMount)
  if (!split) return url
  const { mount, rest } = split
  // An absolute prefix skips `basePath`, so the page under it has none either.
  const base = isAbsoluteUrl(mount)
    ? ''
    : stripTrailingSlashes(joinUrlPrefix(previewMount.basePath, '/'))
  return rest.startsWith('/') ? `${base}${rest}` : `${base || '/'}${rest}`
}

/**
 * `src` asking for the site's header and footer, or `undefined` when it cannot. Only a page under
 * the `previewPrefix` mount is a `createPreviewPage` route, which reads `chrome=1`; any other URL
 * is a page of the site itself, which the editor leaves as it is.
 */
export const siteChromeSrc = (src: string, mount: PreviewMount = {}): string | undefined => {
  if (!splitPreviewPrefix(src, mount)) return undefined
  const hashIndex = src.indexOf('#')
  const beforeHash = hashIndex === -1 ? src : src.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : src.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  if (
    queryIndex !== -1 &&
    beforeHash
      .slice(queryIndex + 1)
      .split('&')
      .includes(SITE_CHROME_PART)
  ) {
    return src
  }
  const separator = queryIndex === -1 ? '?' : beforeHash.endsWith('?') ? '' : '&'
  return `${beforeHash}${separator}${SITE_CHROME_PART}${hash}`
}

/**
 * The previewed page's path on the site, as the preview toolbar shows and copies it: without the
 * `previewPrefix` mount, the `branch` query the top bar already names, `chrome=1`, or a fragment. A relative
 * URL stays relative. An absolute one keeps its origin, since it may be another site, unless an
 * absolute `previewPrefix` mount is what was taken out.
 */
export const displayPreviewPath = (src: string, mount: PreviewMount = {}): string => {
  const url = stripPreviewPrefix(src, mount)
  let parsed: URL
  try {
    parsed = new URL(url, 'http://preview.invalid')
  } catch {
    return url
  }
  const query = filterQuery(
    parsed.search,
    (part) => part !== SITE_CHROME_PART && part.split('=', 1)[0] !== 'branch',
  )
  const path = `${parsed.pathname}${query}`
  if (!isAbsoluteUrl(url)) return path
  // `origin` is 'null' for a scheme the URL spec does not treat as special.
  return url.startsWith('//')
    ? `//${parsed.host}${path}`
    : `${parsed.protocol}//${parsed.host}${path}`
}

/**
 * The page `url` shows, as origin plus `displayPreviewPath` without a trailing slash, so a preview
 * link and the entry `src` framing its page match, under the `previewPrefix` mount or not.
 */
export const previewPageKey = (
  url: string,
  mount: PreviewMount,
  base: string,
): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url, base)
  } catch {
    return undefined
  }
  // A relative mount is a path on the editor's origin, so a URL there is matched to it as a path.
  const spelled =
    splitPreviewPrefix(parsed.href, mount) || parsed.origin !== new URL(base).origin
      ? parsed.href
      : `${parsed.pathname}${parsed.search}`
  return `${parsed.origin}${normalizePreviewPath(displayPreviewPath(spelled, mount))}`
}
