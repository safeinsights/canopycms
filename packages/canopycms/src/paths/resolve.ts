/**
 * Path resolution utilities for converting between physical and logical paths.
 */

import type { FlatSchemaItem } from '../config'
import type { LogicalPath } from './types'

/**
 * Resolve a physical collection path to its logical path.
 *
 * Physical paths contain embedded IDs (e.g., "content/authors.q52DCVPuH4ga"),
 * while logical paths are schema-defined (e.g., "content/authors").
 *
 * This function matches physical path segments to logical path segments,
 * accounting for ID suffixes in physical paths.
 *
 * @param physicalPath - The physical filesystem path with embedded IDs
 * @param schemaItems - Iterable of schema items to search
 * @returns The matching logical path, or the physical path if no match found
 *
 * @example
 * // Match physical to logical
 * resolveLogicalPath("content/authors.q52DCVPuH4ga", schemaItems)
 * // Returns: "content/authors"
 *
 * @example
 * // Nested collections
 * resolveLogicalPath("content/docs.ABC/api.DEF", schemaItems)
 * // Returns: "content/docs/api"
 */
export function resolveLogicalPath(
  physicalPath: string,
  schemaItems: Iterable<FlatSchemaItem>
): LogicalPath | string {
  const pathSegments = physicalPath.split('/')

  for (const schemaItem of schemaItems) {
    if (schemaItem.type === 'collection') {
      const logicalSegments = schemaItem.logicalPath.split('/')

      // Check if all logical segments match the corresponding physical segments
      // (ignoring the ID part after the dot in directory names)
      if (pathSegments.length === logicalSegments.length) {
        const matches = logicalSegments.every((logicalSeg, i) => {
          const physicalSeg = pathSegments[i]
          // Physical segment might have ID: "authors.q52DCVPuH4ga"
          // Logical segment: "authors"
          // Match if identical OR if physical starts with logical + '.'
          return physicalSeg === logicalSeg || physicalSeg.startsWith(logicalSeg + '.')
        })

        if (matches) {
          return schemaItem.logicalPath
        }
      }
    }
  }

  // Fallback: return the physical path if we can't find a match
  return physicalPath
}
