'use client'

import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatCanopyPath, type CanopyPathSegment } from './canopy-path'

export const __CANOPY_PREVIEW_CLIENT__ = true

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
}

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
 * True only for messages from the embedding editor window with the expected origin.
 *
 * Security: preview hooks feed message data into the host site's renderer (often
 * MDX evaluation), so accepting a message from an arbitrary window would let any
 * page with a handle on this window (e.g. via window.open) execute content in the
 * site's origin. Messages must come from the direct parent frame AND match the
 * expected editor origin (same-origin unless `editorOrigin` is configured).
 */
export const isTrustedEditorMessage = (event: MessageEvent, editorOrigin?: string): boolean =>
  typeof window !== 'undefined' &&
  window.parent !== window &&
  event.origin === resolveMessageOrigin(editorOrigin) &&
  event.source === window.parent

export const sendDraftUpdate = (
  iframe: HTMLIFrameElement | null,
  message: DraftUpdateMessage,
  targetOrigin?: string,
) => {
  if (!iframe?.contentWindow) return
  iframe.contentWindow.postMessage(message, targetOrigin ?? resolveMessageOrigin(iframe.src))
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
 * (e.g. malformed MDX). `message: null` clears a previously reported error.
 */
export interface PreviewErrorMessage {
  type: typeof CANOPY_PREVIEW_ERROR
  path: string
  message: string | null
  fieldPath?: string
}

/**
 * Convenience hook that wires draft updates, focus emitter, and highlight toggling together.
 * Returns live data plus helpers for setting data-canopy-path attributes.
 */
const resolvePreviewPath = (explicit?: string): string => {
  if (explicit) return explicit
  if (typeof window === 'undefined') return ''
  return `${window.location.pathname}${window.location.search}`
}

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
      const msg: PreviewErrorMessage = {
        type: CANOPY_PREVIEW_ERROR,
        path: resolvedPath,
        message,
        ...(fieldPath !== undefined ? { fieldPath } : {}),
      }
      window.parent.postMessage(msg, resolveMessageOrigin(editorOrigin))
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
      if (!msg || msg.type !== CANOPY_PREVIEW_MESSAGE || msg.path !== path) return
      setData(msg.data as T)
      if (msg.isLoading !== undefined) {
        setIsLoading(msg.isLoading as Record<string, boolean>)
      }
    }
    window.addEventListener('message', handler)
    // Notify parent that this preview page is ready to receive draft updates.
    // This is needed because onLoad in the parent fires before React effects run,
    // so the first postMessage from the parent arrives before this listener is set up.
    window.parent.postMessage(
      { type: CANOPY_PREVIEW_READY, path },
      resolveMessageOrigin(editorOrigin),
    )
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
      const msg: PreviewFocusMessage = {
        type: CANOPY_PREVIEW_FOCUS,
        entryPath,
        fieldPath,
      }
      window.parent.postMessage(msg, resolveMessageOrigin(editorOrigin))
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [entryPath, editorOrigin])
}

/**
 * Lightweight iframe wrapper to keep the preview in sync with form state.
 * It posts the latest draft data to the iframe after load and when data changes.
 */
export const PreviewFrame = ({
  src,
  path,
  data,
  isLoading,
  className,
  style,
  highlightEnabled,
  onPreviewError,
}: {
  src: string
  path: string
  data?: unknown
  isLoading?: unknown
  className?: string
  style?: CSSProperties
  highlightEnabled?: boolean
  /** Called when the preview reports a draft compile/render error; null clears it. */
  onPreviewError?: (error: { message: string; fieldPath?: string } | null) => void
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Pin the preview origin from the src prop: outbound messages target it (never '*'),
  // and inbound messages must come from it. An iframe that navigates cross-origin
  // silently stops participating in the bridge.
  const previewOrigin = resolveMessageOrigin(src)
  // Show progress bar while waiting for the preview's ready handshake.
  const [syncPending, setSyncPending] = useState(data !== undefined)

  // Reset when navigating to a different entry (src change = new iframe page load).
  const [prevSrc, setPrevSrc] = useState(src)
  if (src !== prevSrc) {
    setPrevSrc(src)
    setSyncPending(data !== undefined)
  }

  // Inject the progress bar keyframe animation once per page.
  useEffect(() => {
    const styleId = 'canopycms-preview-sync-style'
    if (!document.getElementById(styleId)) {
      const el = document.createElement('style')
      el.id = styleId
      el.textContent = `@keyframes canopy-preview-sync { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }`
      document.head.appendChild(el)
    }
  }, [])

  const post = () => {
    if (data === undefined) return
    sendDraftUpdate(
      iframeRef.current,
      {
        type: CANOPY_PREVIEW_MESSAGE,
        path,
        data,
        isLoading,
      },
      previewOrigin,
    )
  }
  const postHighlight = () => {
    if (!iframeRef.current?.contentWindow) return
    const msg: HighlightMessage = {
      type: CANOPY_PREVIEW_HIGHLIGHT,
      enabled: Boolean(highlightEnabled),
    }
    iframeRef.current.contentWindow.postMessage(msg, previewOrigin)
  }

  // Keep refs pointing at the latest closures so the message handler below never goes stale.
  const postRef = useRef(post)
  const postHighlightRef = useRef(postHighlight)
  const onPreviewErrorRef = useRef(onPreviewError)
  useEffect(() => {
    postRef.current = post
    postHighlightRef.current = postHighlight
    onPreviewErrorRef.current = onPreviewError
  })

  useEffect(() => {
    post()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- post is tracked via ref
  }, [data, isLoading])

  useEffect(() => {
    postHighlight()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- postHighlight is tracked via ref
  }, [highlightEnabled])

  // When the preview page's React effects have run and its message listener is ready,
  // it sends CANOPY_PREVIEW_READY. We respond with the current data so the preview
  // receives the draft even if it wasn't ready when onLoad fired.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return
      // Source check alone is insufficient if the iframe navigated cross-origin.
      if (event.origin !== previewOrigin) return
      const type = (event.data as { type?: string })?.type
      if (type === CANOPY_PREVIEW_READY) {
        postRef.current()
        postHighlightRef.current()
        setSyncPending(false)
      } else if (type === CANOPY_PREVIEW_ERROR) {
        const msg = event.data as PreviewErrorMessage
        onPreviewErrorRef.current?.(
          msg.message == null
            ? null
            : { message: msg.message, ...(msg.fieldPath ? { fieldPath: msg.fieldPath } : {}) },
        )
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [previewOrigin])

  return (
    <div className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      {syncPending && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 1,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              height: '100%',
              width: '40%',
              background: 'var(--mantine-color-blue-filled, #228be6)',
              borderRadius: '0 2px 2px 0',
              animation: 'canopy-preview-sync 1.5s ease-in-out infinite',
            }}
          />
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={src}
        style={{
          display: 'block',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
        }}
        onLoad={() => {
          post()
          postHighlight()
        }}
      />
    </div>
  )
}
