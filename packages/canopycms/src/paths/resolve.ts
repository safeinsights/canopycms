/**
 * Path resolution utilities for converting between physical and logical paths.
 */

import type { FlatSchemaItem } from '../config'
import type { LogicalPath } from './types'

/**
 * Resolve a physical collection path (segments carry embedded IDs, e.g.
 * "content/authors.q52DCVPuH4ga") to its schema-defined logical path
 * ("content/authors"), or back to the physical path when nothing matches.
 *
 * @example
 * resolveLogicalPath("content/docs.ABC/api.DEF", schemaItems)
 * // Returns: "content/docs/api"
 * @internal Exported for tests.
 */
export function resolveLogicalPath(
  physicalPath: string,
  schemaItems: Iterable<FlatSchemaItem>,
): LogicalPath | string {
  const pathSegments = physicalPath.split('/')

  for (const schemaItem of schemaItems) {
    if (schemaItem.type === 'collection') {
      const logicalSegments = schemaItem.logicalPath.split('/')

      if (pathSegments.length === logicalSegments.length) {
        const matches = logicalSegments.every((logicalSeg, i) => {
          const physicalSeg = pathSegments[i]
          // Match if identical OR if physical starts with logical + '.'
          return physicalSeg === logicalSeg || physicalSeg.startsWith(logicalSeg + '.')
        })

        if (matches) {
          return schemaItem.logicalPath
        }
      }
    }
  }

  return physicalPath
}
