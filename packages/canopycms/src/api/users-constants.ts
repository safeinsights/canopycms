/**
 * Constants the user endpoints share with the editor, kept dependency-free so the editor's
 * browser bundle can import them without pulling in `permissions.ts` and its server-only deps.
 */

/** Most user ids one `POST /users/batch` request may carry; the editor splits larger sets. */
export const MAX_USER_METADATA_BATCH = 100
