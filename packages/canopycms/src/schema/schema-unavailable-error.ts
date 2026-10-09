import type { EntryTypeUnavailable } from '../config'

/**
 * Thrown for an entry whose entry type is `unavailable` (see `EntryTypeConfig.unavailable`):
 * nothing may be written against a schema the running code does not have. The API answers it
 * with a retriable 503 (`http/worker-not-ready.ts`), since a deploy usually clears it.
 */
export class SchemaUnavailableError extends Error {
  readonly entryType: string
  readonly unavailable: EntryTypeUnavailable

  constructor(entryType: string, unavailable: EntryTypeUnavailable) {
    super(
      `Entry type "${entryType}" uses a content type this editor version doesn't know yet ` +
        `("${unavailable.schemaRef}", named in ${unavailable.metaFile}). It usually appears ` +
        'after the editor finishes updating; reload in a few minutes.',
    )
    this.name = 'SchemaUnavailableError'
    this.entryType = entryType
    this.unavailable = unavailable
  }
}
