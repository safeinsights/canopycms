import { stripTrailingSlashes } from '../utils/url-prefix'

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
