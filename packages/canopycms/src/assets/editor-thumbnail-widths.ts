/**
 * The widths the editor's media UI requests through the raw route: a library list row, a library
 * card and an image field's preview. Finalize stores each for a still raster upload, new or
 * re-uploaded (`storeEditorThumbnails`), so a first view reads a stored object instead of
 * transforming in the request. Isomorphic: the editor components and finalize both import it.
 */
export const EDITOR_THUMBNAIL_WIDTHS = { listRow: 80, card: 160, imageField: 320 } as const
