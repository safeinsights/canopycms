import type { ContentFormat } from '../config'

/**
 * Get the file extension for a content format
 * @param format - The content format (md, mdx, json, yaml)
 * @returns The file extension including the dot (e.g., '.md', '.json', '.yaml')
 */
export const getFormatExtension = (format: ContentFormat): string => {
  if (format === 'md') return '.md'
  if (format === 'mdx') return '.mdx'
  if (format === 'yaml') return '.yaml'
  return '.json'
}

/** Returns true for data-only formats (no body/frontmatter separation) */
export const isDataOnlyFormat = (format: ContentFormat): boolean =>
  format === 'json' || format === 'yaml'

/** Safely coerce a parsed value to a record, returning {} for non-object values */
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
