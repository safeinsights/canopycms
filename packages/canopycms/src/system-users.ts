/**
 * The user ids CanopyCMS itself acts as, never a person. Dependency-free, so the editor bundle can
 * import it.
 */

/** Owner of a branch CanopyCMS provisions itself (http/handler.ts); see authorization/branch.ts. */
export const SYSTEM_USER_ID = 'canopycms-system'

/** Owner recorded by a content read outside any request (content-reader.ts). */
export const CONTENT_READER_USER_ID = 'canopycms-content-reader'

/** Owner recorded for the active branch a server context provisions (context.ts). */
export const CONTEXT_USER_ID = 'canopycms-context'

/** True for a user id CanopyCMS acts as; the editor shows these as "CanopyCMS bot". */
export const isSystemUserId = (userId: string): boolean =>
  userId === SYSTEM_USER_ID || userId === CONTENT_READER_USER_ID || userId === CONTEXT_USER_ID
