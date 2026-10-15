import { isAbsoluteUrl, joinUrlPrefix, stripTrailingSlashes } from '../utils/url-prefix'

/**
 * Reduces a preview URL to what identifies the page, its path and query, with no origin,
 * fragment or trailing slash. The editor names a page by the `src` it built and the framed page
 * by its own location. An absolute `src`, or a host redirect that adds or drops a trailing slash,
 * spells the same page two ways, and the bridge must still match them.
 * @internal Exported for tests.
 */
export const normalizePreviewPath = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url, 'http://preview.invalid')
  } catch {
    return url
  }
  return `${stripTrailingSlashes(parsed.pathname) || '/'}${parsed.search}`
}

/** Whether two preview URLs name the same page; see `normalizePreviewPath`. */
export const isSamePreviewPath = (a: string, b: string): boolean =>
  normalizePreviewPath(a) === normalizePreviewPath(b)

/** Where `buildPreviewSrc` mounts the preview routes, and the `basePath` the site's pages keep. */
export interface PreviewMount {
  basePath?: string
  previewPrefix?: string
}

/** `url` with the `previewPrefix` mount taken out, so `/base/preview/posts/x` reads `/base/posts/x`. */
const stripPreviewPrefix = (url: string, { basePath, previewPrefix }: PreviewMount): string => {
  if (!previewPrefix || !stripTrailingSlashes(previewPrefix)) return url
  const mount = stripTrailingSlashes(joinUrlPrefix(basePath, joinUrlPrefix(previewPrefix, '/')))
  if (!url.startsWith(mount)) return url
  const rest = url.slice(mount.length)
  if (rest !== '' && !/^[/?#]/.test(rest)) return url
  // An absolute prefix skips `basePath`, so the page under it has none either.
  const base = isAbsoluteUrl(mount) ? '' : stripTrailingSlashes(joinUrlPrefix(basePath, '/'))
  return rest.startsWith('/') ? `${base}${rest}` : `${base || '/'}${rest}`
}

/**
 * The previewed page's path on the site, as the preview toolbar shows and copies it: without the
 * `previewPrefix` mount, the `branch` query the top bar already names, or a fragment. A relative
 * URL stays relative; an absolute one keeps its origin, since it may be another site.
 */
export const displayPreviewPath = (src: string, mount: PreviewMount = {}): string => {
  const url = stripPreviewPrefix(src, mount)
  let parsed: URL
  try {
    parsed = new URL(url, 'http://preview.invalid')
  } catch {
    return url
  }
  // Filtered as raw text: a URLSearchParams round trip would re-encode the query it keeps.
  const query = parsed.search
    .slice(1)
    .split('&')
    .filter((part) => part !== '' && part.split('=', 1)[0] !== 'branch')
    .join('&')
  const path = `${parsed.pathname}${query ? `?${query}` : ''}`
  if (!isAbsoluteUrl(url)) return path
  // `origin` is 'null' for a scheme the URL spec does not treat as special.
  return url.startsWith('//')
    ? `//${parsed.host}${path}`
    : `${parsed.protocol}//${parsed.host}${path}`
}
