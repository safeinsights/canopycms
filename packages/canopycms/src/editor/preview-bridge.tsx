'use client'

/**
 * The preview bridge's protocol and its host-page side: the hooks a framed page runs. Served to
 * hosts through `canopycms/preview`, so everything it reaches stays free of CSS and editor UI
 * (`pnpm lint:bundle`); the editor's side is `PreviewFrame.tsx`.
 */

import { useCallback, useEffect, useState } from 'react'

import { toSameOriginPath } from '../utils/url-prefix'
import { formatCanopyPath, type CanopyPathSegment } from './canopy-path'
import { setPreviewAssetBase } from './preview-asset-base'
import { isSamePreviewPath } from './preview-path'

export const CANOPY_PREVIEW_MESSAGE = 'canopycms:draft:update'
export const CANOPY_PREVIEW_FOCUS = 'canopycms:preview:focus'
export const CANOPY_PREVIEW_HIGHLIGHT = 'canopycms:preview:highlight'
export const CANOPY_PREVIEW_READY = 'canopycms:preview:ready'
export const CANOPY_PREVIEW_ERROR = 'canopycms:preview:error'

export interface DraftUpdateMessage {
  type: typeof CANOPY_PREVIEW_MESSAGE
  path: string
  data?: unknown
  isLoading?: unknown
  /** The editor's authenticated asset route; see `PreviewFrame`'s `assetBase`. */
  assetBase?: unknown
}

/** `assetBase` from a draft, only if it is a same-origin path: nothing else may steer `<img>`s. */
const readAssetBase = (value: unknown): string | undefined =>
  typeof value === 'string' && value.startsWith('/') && toSameOriginPath(value) === value
    ? value
    : undefined

/**
 * Resolve a (possibly relative) URL to an origin for postMessage targeting.
 * Falls back to the page's own origin, so same-origin editor/preview setups
 * need no configuration.
 */
export const resolveMessageOrigin = (url?: string): string => {
  if (typeof window === 'undefined') return ''
  if (!url) return window.location.origin
  try {
    return new URL(url, window.location.href).origin
  } catch {
    return window.location.origin
  }
}

/**
 * Opaque origins (sandboxed iframes, data: URLs) serialize to the string 'null':
 * never trust them for inbound messages, and never post to them — every window in
 * a sandboxed embed shares that string, so it identifies nothing, and postMessage
 * throws on a literal 'null' targetOrigin. '' covers the SSR fallback.
 */
export const isOpaqueOrigin = (origin: string): boolean => origin === 'null' || origin === ''

/**
 * True only for messages from the embedding editor window with the expected origin.
 *
 * Security: preview hooks feed message data into the host site's renderer (often
 * MDX evaluation), so accepting a message from an arbitrary window would let any
 * page with a handle on this window (e.g. via window.open) execute content in the
 * site's origin. Messages must come from the direct parent frame AND match the
 * expected editor origin (same-origin unless `editorOrigin` is configured).
 */
export const isTrustedEditorMessage = (event: MessageEvent, editorOrigin?: string): boolean => {
  if (typeof window === 'undefined' || window.parent === window) return false
  const expected = resolveMessageOrigin(editorOrigin)
  if (isOpaqueOrigin(expected)) return false
  return event.origin === expected && event.source === window.parent
}

export interface PreviewFocusMessage {
  type: typeof CANOPY_PREVIEW_FOCUS
  entryPath: string
  fieldPath: string
}

export interface HighlightMessage {
  type: typeof CANOPY_PREVIEW_HIGHLIGHT
  enabled: boolean
}

/**
 * Preview → editor report that the current draft fails to compile/render
 * (e.g. malformed MDX). `message: null` clears an earlier error.
 */
export interface PreviewErrorMessage {
  type: typeof CANOPY_PREVIEW_ERROR
  path: string
  message: string | null
  fieldPath?: string
}

const resolvePreviewPath = (explicit?: string): string => {
  if (explicit) return explicit
  if (typeof window === 'undefined') return ''
  return `${window.location.pathname}${window.location.search}`
}

/**
 * Convenience hook that wires draft updates, focus emitter, and highlight toggling together.
 * Returns live data plus helpers for setting data-canopy-path attributes.
 */
export const useCanopyPreview = <T,>(opts: {
  path?: string
  initialData: T
  /** Editor origin to trust for preview messages. Defaults to this page's own origin. */
  editorOrigin?: string
}) => {
  const resolvedPath = resolvePreviewPath(opts.path)
  const editorOrigin = opts.editorOrigin
  const bridgeOpts = { editorOrigin }
  const { data, isLoading } = usePreviewData<T>(resolvedPath, opts.initialData, bridgeOpts)
  const highlightEnabled = usePreviewHighlight(bridgeOpts)
  usePreviewFocusEmitter(resolvedPath, bridgeOpts)

  const fieldProps = (canopyPath: string | CanopyPathSegment[]) => ({
    'data-canopy-path': Array.isArray(canopyPath) ? formatCanopyPath(canopyPath) : canopyPath,
  })

  /**
   * Report that the current draft fails to compile/render (the editor surfaces it
   * next to the preview). Call with null once the draft renders cleanly again.
   * No-op outside an editor frame.
   */
  const reportError = useCallback(
    (message: string | null, fieldPath?: string) => {
      if (typeof window === 'undefined' || window.parent === window) return
      const target = resolveMessageOrigin(editorOrigin)
      if (isOpaqueOrigin(target)) return
      const msg: PreviewErrorMessage = {
        type: CANOPY_PREVIEW_ERROR,
        path: resolvedPath,
        message,
        ...(fieldPath !== undefined ? { fieldPath } : {}),
      }
      window.parent.postMessage(msg, target)
    },
    [resolvedPath, editorOrigin],
  )

  return { data, isLoading, highlightEnabled, fieldProps, reportError }
}

/**
 * Hook for preview pages to listen for draft updates from the parent editor.
 * Returns both data and loading state.
 */
export const usePreviewData = <T,>(
  path: string,
  initialData: T,
  opts?: { editorOrigin?: string },
): { data: T; isLoading: Record<string, boolean> } => {
  const [data, setData] = useState<T>(initialData)
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({})
  const editorOrigin = opts?.editorOrigin

  useEffect(() => {
    // Only listen when actually framed by an editor; a standalone page (including
    // one opened via window.open from a hostile site) must never accept drafts.
    if (window.parent === window) return
    const handler = (event: MessageEvent) => {
      if (!isTrustedEditorMessage(event, editorOrigin)) return
      const msg = event.data as DraftUpdateMessage
      if (!msg || msg.type !== CANOPY_PREVIEW_MESSAGE) return
      if (typeof msg.path !== 'string' || !isSamePreviewPath(msg.path, path)) return
      // Before setData, so the render the draft triggers already reads it.
      setPreviewAssetBase(readAssetBase(msg.assetBase))
      setData(msg.data as T)
      if (msg.isLoading !== undefined) {
        setIsLoading(msg.isLoading as Record<string, boolean>)
      }
    }
    window.addEventListener('message', handler)
    // Notify parent that this preview page is ready to receive draft updates.
    // This is needed because onLoad in the parent fires before React effects run,
    // so the first postMessage from the parent arrives before this listener is set up.
    const target = resolveMessageOrigin(editorOrigin)
    if (!isOpaqueOrigin(target)) {
      window.parent.postMessage({ type: CANOPY_PREVIEW_READY, path }, target)
    }
    return () => window.removeEventListener('message', handler)
  }, [path, editorOrigin])

  return { data, isLoading }
}

/**
 * Hook for preview pages to listen for highlight mode and toggle an outline on clickable elements.
 */
export const usePreviewHighlight = (opts?: { editorOrigin?: string }) => {
  const [enabled, setEnabled] = useState(false)
  const editorOrigin = opts?.editorOrigin

  useEffect(() => {
    const styleId = 'canopycms-preview-highlight-style'
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null
    if (enabled) {
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = styleId
        styleEl.textContent = `
          [data-canopy-path] { outline: 2px dashed rgba(79,70,229,0.6); outline-offset: 3px; cursor: pointer; }
        `
        document.head.appendChild(styleEl)
      }
    } else if (styleEl) {
      styleEl.remove()
    }
  }, [enabled])

  useEffect(() => {
    if (window.parent === window) return
    const handler = (event: MessageEvent) => {
      if (!isTrustedEditorMessage(event, editorOrigin)) return
      const msg = event.data as HighlightMessage
      if (msg?.type !== CANOPY_PREVIEW_HIGHLIGHT) return
      setEnabled(Boolean(msg.enabled))
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [editorOrigin])

  return enabled
}

/**
 * Hook for preview pages to emit focus messages when elements with data-canopy-path are clicked.
 */
export const usePreviewFocusEmitter = (entryPath: string, opts?: { editorOrigin?: string }) => {
  const editorOrigin = opts?.editorOrigin
  useEffect(() => {
    if (window.parent === window) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const el = target.closest<HTMLElement>('[data-canopy-path]')
      const fieldPath = el?.dataset.canopyPath
      if (!fieldPath) return
      const targetOrigin = resolveMessageOrigin(editorOrigin)
      if (isOpaqueOrigin(targetOrigin)) return
      const msg: PreviewFocusMessage = {
        type: CANOPY_PREVIEW_FOCUS,
        entryPath,
        fieldPath,
      }
      window.parent.postMessage(msg, targetOrigin)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [entryPath, editorOrigin])
}
