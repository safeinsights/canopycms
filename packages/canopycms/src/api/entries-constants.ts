/**
 * Pagination constants for the entries list endpoint. Kept dependency-free (no server-only
 * imports) so the editor's browser bundle can import the page-size cap without pulling in
 * `entries.ts` and its `node:fs`-backed deps; `entries.ts` re-exports these for API discoverability.
 */

/**
 * Maximum entries the list endpoint returns per request; larger `limit` values are clamped to
 * this so paginating clients never silently drift from the server's cap.
 */
export const MAX_ENTRIES_PER_PAGE = 200

/** Default page size when a request omits `limit`. */
export const DEFAULT_ENTRIES_LIMIT = 50
