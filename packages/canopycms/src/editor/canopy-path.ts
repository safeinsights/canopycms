export type CanopyPathSegment = string | number

/**
 * Convert a list of path segments into the canonical CanopyCMS path string.
 * Arrays are rendered with bracket notation (e.g., blocks[0].title).
 */
export const formatCanopyPath = (segments: CanopyPathSegment[]): string => {
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
      // Allow dotted numeric segments (e.g., blocks.0.title)
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

/**
 * Normalize any supported path input (string or segments) into the
 * canonical bracketed representation.
 */
export const normalizeCanopyPath = (input: string | CanopyPathSegment[]): string => {
  if (Array.isArray(input)) {
    return formatCanopyPath(input)
  }
  return formatCanopyPath(parseCanopyPath(input))
}
