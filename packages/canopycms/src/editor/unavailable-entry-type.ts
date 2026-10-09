/**
 * Author-facing wording for an entry type the running code cannot resolve (see
 * `EntryTypeUnavailable`). Dependency-free so any client module can import it.
 */

import type { ApiErrorCode } from '../api/types'

/** `ApiResponse.code` of the 503 the API answers with for an entry of an unavailable type. */
export const SCHEMA_UNAVAILABLE_CODE = 'SCHEMA_UNAVAILABLE' satisfies ApiErrorCode

const HEAD = "This section uses a content type this editor version doesn't know yet"
const TAIL = 'It usually appears after the editor finishes updating; reload in a few minutes.'

/**
 * The message split around the schema refs, so a renderer can set the refs in a code style.
 * With no refs (a 503 on an entry the schema did not flag) the parenthetical is omitted.
 */
export function unavailableTypeMessageParts(schemaRefs: readonly string[]): {
  before: string
  after: string
} {
  const hasRefs = schemaRefs.length > 0
  return {
    before: hasRefs ? `${HEAD} (` : HEAD,
    after: `${hasRefs ? ')' : ''}. ${TAIL}`,
  }
}

/** The distinct schema refs of the unavailable entry types in `entryTypes`, in order. */
export function unavailableSchemaRefs(
  entryTypes: ReadonlyArray<{ unavailable?: { schemaRef: string } }> | undefined,
): string[] {
  const refs: string[] = []
  for (const et of entryTypes ?? []) {
    if (et.unavailable && !refs.includes(et.unavailable.schemaRef))
      refs.push(et.unavailable.schemaRef)
  }
  return refs
}
