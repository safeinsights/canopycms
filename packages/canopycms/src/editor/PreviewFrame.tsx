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
  MARK_REPORT_LIMITS,
  type PreviewErrorMessage,
  type PreviewMarksMessage,
  resolveMessageOrigin,
} from './preview-bridge'

/** What the preview reports of its marks; see `PreviewMarksMessage`. */
export interface PreviewMarks {
  count: number
  paths?: string[]
}

/**
 * How long after the iframe's `load` the preview has to send its ready message before the frame
 * says live updates are off. Ready can also arrive before `load`, which waits for images too.
 */
const READY_TIMEOUT_MS = 5000

/**
 * `waiting` until the preview's ready message arrives, `missing` once `READY_TIMEOUT_MS` passes
 * after `load` without one. A late ready still moves it to `ready`.
 */
type Handshake = 'waiting' | 'ready' | 'missing'

const LIVE_UPDATES_OFF_HELP =
  "The preview didn't connect, so your edits won't show in it until it reconnects. Retry reloads the preview; your edits are kept."

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const isMarkPaths = (paths: unknown): paths is string[] =>
  Array.isArray(paths) &&
  paths.length <= MARK_REPORT_LIMITS.paths &&
  paths.every((path) => typeof path === 'string' && path.length <= MARK_REPORT_LIMITS.pathLength)

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
 * It posts the latest draft data to the iframe after load and when data changes. A progress bar
 * runs until the preview's ready message arrives; when none does, a "Live updates off" chip offers
 * to reload the preview.
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
  onMarks,
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
  /**
   * Called with how many elements the preview marks, while highlighting is on, and their
   * distinct paths when the preview sends them within `MARK_REPORT_LIMITS`.
   */
  onMarks?: (marks: PreviewMarks) => void
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Pin the preview origin from the src prop: outbound messages target it (never '*'),
  // and inbound messages must come from it. An iframe that navigates cross-origin
  // silently stops participating in the bridge.
  const previewOrigin = resolveMessageOrigin(src)
  // Only the ready message clears the progress bar: `onLoad` can post the draft before the
  // preview's listener exists, so only the re-post that ready triggers is sure to land.
  const [handshake, setHandshake] = useState<Handshake>('waiting')
  const [loaded, setLoaded] = useState(false)
  // Retry and a new src each mount a fresh iframe rather than navigating the old one, so a late
  // ready from the page it replaces fails the source check, and a late load has no handler.
  const [retries, setRetries] = useState(0)

  // A new src is a new page, with a handshake of its own.
  const [prevSrc, setPrevSrc] = useState(src)
  if (src !== prevSrc) {
    setPrevSrc(src)
    setHandshake('waiting')
    setLoaded(false)
  }

  useEffect(() => {
    if (!loaded || handshake !== 'waiting') return
    // Functional, so a ready batched into the same render as this callback still wins.
    const timer = setTimeout(
      () => setHandshake((current) => (current === 'waiting' ? 'missing' : current)),
      READY_TIMEOUT_MS,
    )
    return () => clearTimeout(timer)
  }, [loaded, handshake])

  const retry = () => {
    setHandshake('waiting')
    setLoaded(false)
    setRetries((count) => count + 1)
  }

  const hasDraft = data !== undefined
  const syncPending = hasDraft && handshake === 'waiting'
  const liveUpdatesOff = hasDraft && handshake === 'missing'

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
  const onMarksRef = useRef(onMarks)
  useEffect(() => {
    postRef.current = post
    postHighlightRef.current = postHighlight
    onPreviewErrorRef.current = onPreviewError
    onMarksRef.current = onMarks
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
        setHandshake('ready')
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
        const { count, paths } = event.data as Partial<PreviewMarksMessage>
        if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
          onMarksRef.current?.({ count, ...(isMarkPaths(paths) ? { paths } : {}) })
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
          role="progressbar"
          aria-label="Connecting to the preview"
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
      {/* Mounted empty, so screen readers announce the chip when it is inserted. */}
      <div role="status" style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>
        {liveUpdatesOff && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 4px 2px 10px',
              borderRadius: 999,
              border: '1px solid var(--mantine-color-gray-4, #ced4da)',
              background: 'var(--mantine-color-white, #fff)',
              boxShadow: 'var(--mantine-shadow-xs, 0 1px 3px rgba(0, 0, 0, 0.1))',
              color: 'var(--mantine-color-gray-7, #495057)',
              fontFamily: 'var(--mantine-font-family, inherit)',
              fontSize: 12,
              lineHeight: '20px',
            }}
          >
            <span title={LIVE_UPDATES_OFF_HELP}>Live updates off</span>
            <span style={visuallyHidden}>{LIVE_UPDATES_OFF_HELP}</span>
            <button
              type="button"
              onClick={retry}
              title="Reload the preview"
              style={{
                border: 'none',
                borderRadius: 999,
                padding: '0 8px',
                background: 'transparent',
                color: 'var(--mantine-color-blue-filled, #228be6)',
                font: 'inherit',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
      <iframe
        key={`${retries}:${src}`}
        ref={iframeRef}
        src={src}
        title="Live preview"
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
          setLoaded(true)
        }}
      />
    </div>
  )
}
