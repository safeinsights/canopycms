import type { ContentFormat } from '../config'

/**
 * Get the file extension for a content format
 * @param format - The content format (md, mdx, json)
 * @returns The file extension including the dot (e.g., '.md', '.json')
 */
export const getFormatExtension = (format: ContentFormat): string => {
  if (format === 'md') return '.md'
  if (format === 'mdx') return '.mdx'
  return '.json'
}
