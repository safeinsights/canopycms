/**
 * The one spelling of a field path, `blocks[0].title`, for the form's fields, the preview's
 * marks and comment threads. A digits-only segment is always a list index (`[0]` or `.0`):
 * schemas refuse field names `isPathFieldName` rejects, since no path could spell them.
 */

export type CanopyPathSegment = string | number

export const isPathFieldName = (name: string): boolean =>
  name.length > 0 && !/^\d+$/.test(name) && !/[.[\]]/.test(name)

/**
 * Convert a list of path segments into the canonical CanopyCMS path string.
 * Arrays are rendered with bracket notation (e.g., blocks[0].title).
 */
export const formatCanopyPath = (segments: readonly CanopyPathSegment[]): string => {
  return segments.reduce<string>((acc, segment, index) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`
    }
    const prefix = index === 0 ? '' : '.'
    return `${acc}${prefix}${segment}`
  }, '')
}

/**
 * Parse a CanopyCMS path string into segments. Supports bracketed array
 * indices and dotted segments (e.g., blocks.0.title or blocks[0].title).
 */
export const parseCanopyPath = (path: string): CanopyPathSegment[] => {
  const segments: CanopyPathSegment[] = []
  const matcher = /([^[.\]]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null

  while ((match = matcher.exec(path)) !== null) {
    if (match[1]) {
      const raw = match[1]
      if (/^\d+$/.test(raw)) {
        segments.push(Number(raw))
      } else {
        segments.push(raw)
      }
    } else if (match[2]) {
      segments.push(Number(match[2]))
    }
  }

  return segments
}

/** The canonical string for a path; segments are re-parsed, so `['a', '0']` is `a[0]`. */
export const normalizeCanopyPath = (input: string | readonly CanopyPathSegment[]): string =>
  formatCanopyPath(parseCanopyPath(typeof input === 'string' ? input : formatCanopyPath(input)))
