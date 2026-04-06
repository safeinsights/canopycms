/**
 * Sanitize an untrusted URL for use in `href` attributes.
 *
 * Parses the input with `new URL()` and only allows `http:` and `https:` protocols,
 * blocking `javascript:`, `data:`, `vbscript:`, and other dangerous schemes.
 * Returns the fallback (default `'#'`) for invalid or disallowed URLs.
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
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href
    }
  } catch {
    // invalid URL
  }
  return fallback
}
