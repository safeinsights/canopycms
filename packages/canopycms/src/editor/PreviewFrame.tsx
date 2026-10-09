'use client'

import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

import {
  CANOPY_PREVIEW_ERROR,
  CANOPY_PREVIEW_HIGHLIGHT,
  CANOPY_PREVIEW_MARKS,
  CANOPY_PREVIEW_MESSAGE,
  CANOPY_PREVIEW_READY,
  type DraftUpdateMessage,
  type HighlightMessage,
  isOpaqueOrigin,
  type PreviewErrorMessage,
  type PreviewMarksMessage,
  resolveMessageOrigin,
} from './preview-bridge'

const sendDraftUpdate = (
  iframe: HTMLIFrameElement | null,
  message: DraftUpdateMessage,
  targetOrigin?: string,
) => {
  if (!iframe?.contentWindow) return
  const target = targetOrigin ?? resolveMessageOrigin(iframe.src)
  if (isOpaqueOrigin(target)) return
  iframe.contentWindow.postMessage(message, target)
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
  onMarkCount,
  assetBase,
}: {
  src: string
  path: string
  data?: unknown
  isLoading?: unknown
  className?: string
  style?: CSSProperties
  highlightEnabled?: boolean
  /**
   * The editor's authenticated asset route, a same-origin path, so it is sent with drafts only to
   * a same-origin preview: another origin would resolve it against itself.
   */
  assetBase?: string
  /** Called when the preview reports a draft compile/render error; null clears it. */
  onPreviewError?: (error: { message: string; fieldPath?: string } | null) => void
  /** Called with how many elements the preview marks, while highlighting is on. */
  onMarkCount?: (count: number) => void
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
    const sameOrigin = previewOrigin === window.location.origin
    sendDraftUpdate(
      iframeRef.current,
      {
        type: CANOPY_PREVIEW_MESSAGE,
        path,
        data,
        isLoading,
        ...(assetBase !== undefined && sameOrigin ? { assetBase } : {}),
      },
      previewOrigin,
    )
  }
  const postHighlight = () => {
    if (!iframeRef.current?.contentWindow) return
    if (isOpaqueOrigin(previewOrigin)) return
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
  const onMarkCountRef = useRef(onMarkCount)
  useEffect(() => {
    postRef.current = post
    postHighlightRef.current = postHighlight
    onPreviewErrorRef.current = onPreviewError
    onMarkCountRef.current = onMarkCount
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
      if (isOpaqueOrigin(previewOrigin) || event.origin !== previewOrigin) return
      const type = (event.data as { type?: string })?.type
      if (type === CANOPY_PREVIEW_READY) {
        postRef.current()
        postHighlightRef.current()
        setSyncPending(false)
      } else if (type === CANOPY_PREVIEW_ERROR) {
        const msg = event.data as Partial<PreviewErrorMessage>
        // Shape-check the payload: an adopter passing an Error object (instead of
        // err.message) must not crash the editor when rendered as a React child.
        if (msg.message != null && typeof msg.message !== 'string') return
        const fieldPath = typeof msg.fieldPath === 'string' ? msg.fieldPath : undefined
        onPreviewErrorRef.current?.(
          msg.message == null
            ? null
            : { message: msg.message, ...(fieldPath ? { fieldPath } : {}) },
        )
      } else if (type === CANOPY_PREVIEW_MARKS) {
        const { count } = event.data as Partial<PreviewMarksMessage>
        if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
          onMarkCountRef.current?.(count)
        }
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
