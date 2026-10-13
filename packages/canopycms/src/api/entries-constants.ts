/**
 * Constants the entries and content endpoints share with the editor. Kept dependency-free (no
 * server-only imports) so the editor's browser bundle can import them without pulling in
 * `entries.ts` and its `node:fs`-backed deps.
 */

/**
 * Maximum entries the list endpoint returns per request; larger `limit` values are clamped to
 * this so paginating clients never silently drift from the server's cap.
 */
export const MAX_ENTRIES_PER_PAGE = 200

/** Default page size when a request omits `limit`. */
export const DEFAULT_ENTRIES_LIMIT = 50

/**
 * The generic 409 for a conflicting change to an entry, usually its version moving on since the
 * caller read it. Shared with the editor, whose own pre-save staleness check reports the same.
 */
export const ENTRY_CHANGED_MESSAGE =
  'This entry changed since you opened it. Reload to see the latest version (your unsaved edits will be lost).'

/**
 * The 409 for an update whose entry is gone: deleted or moved since the caller read it (API code
 * `ENTRY_GONE`). The save is refused rather than re-creating the entry; re-creating it is a create
 * the caller makes deliberately.
 */
export const ENTRY_GONE_MESSAGE =
  'This entry was deleted or moved since you opened it, so your changes were not saved.'
