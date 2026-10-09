'use client'

/**
 * What a host page needs from the preview bridge. Everything reachable from here stays free of
 * CSS, `@mantine/*` and editor UI (`pnpm lint:bundle`): a page that imports it renders in the
 * adopter's own styles inside the editor's preview, and ships no editor code to the public.
 */

export {
  CANOPY_PREVIEW_ERROR,
  CANOPY_PREVIEW_FOCUS,
  CANOPY_PREVIEW_HIGHLIGHT,
  CANOPY_PREVIEW_MESSAGE,
  CANOPY_PREVIEW_READY,
  isTrustedEditorMessage,
  resolveMessageOrigin,
  useCanopyPreview,
  usePreviewAssetBaseGate,
  usePreviewData,
  usePreviewFocusEmitter,
  usePreviewHighlight,
} from './editor/preview-bridge'
export type {
  DraftUpdateMessage,
  HighlightMessage,
  PreviewErrorMessage,
  PreviewFocusMessage,
  PreviewLoadingState,
} from './editor/preview-bridge'
export type { CanopyPathSegment } from './editor/canopy-path'
