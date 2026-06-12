/**
 * Pagination constants for the entries list endpoint.
 *
 * Kept in a dependency-free module (no server-only imports) so the editor's
 * browser bundle can import the page-size cap without pulling in `entries.ts`
 * and its `node:fs`-backed transitive deps. `entries.ts` re-exports these for
 * API-surface discoverability.
 */

/**
 * Maximum entries the list endpoint returns per request. Larger `limit` values
 * are clamped to this. Paginating clients request this page size so they never
 * silently drift from the server's cap.
 */
export const MAX_ENTRIES_PER_PAGE = 200

/** Default page size when a request omits `limit`. */
export const DEFAULT_ENTRIES_LIMIT = 50
