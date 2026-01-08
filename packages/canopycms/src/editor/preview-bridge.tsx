'use client'

import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

import { formatCanopyPath, type CanopyPathSegment } from './canopy-path'

export const __CANOPY_PREVIEW_CLIENT__ = true

export const CANOPY_PREVIEW_MESSAGE = 'canopycms:draft:update'
export const CANOPY_PREVIEW_FOCUS = 'canopycms:preview:focus'
export const CANOPY_PREVIEW_HIGHLIGHT = 'canopycms:preview:highlight'

export interface DraftUpdateMessage {
  type: typeof CANOPY_PREVIEW_MESSAGE
  path: string
  data?: unknown
  isLoading?: unknown
}

export const sendDraftUpdate = (iframe: HTMLIFrameElement | null, message: DraftUpdateMessage) => {
  if (!iframe?.contentWindow) return
  iframe.contentWindow.postMessage(message, '*')
}

export interface PreviewFocusMessage {
  type: typeof CANOPY_PREVIEW_FOCUS
  entryId: string
  fieldPath: string
}

export interface HighlightMessage {
  type: typeof CANOPY_PREVIEW_HIGHLIGHT
  enabled: boolean
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

export const useCanopyPreview = <T,>(opts: { path?: string; initialData: T }) => {
  const resolvedPath = resolvePreviewPath(opts.path)
  const { data, isLoading } = usePreviewData<T>(resolvedPath, opts.initialData)
  const highlightEnabled = usePreviewHighlight()
  usePreviewFocusEmitter(resolvedPath)

  const fieldProps = (canopyPath: string | CanopyPathSegment[]) => ({
    'data-canopy-path': Array.isArray(canopyPath) ? formatCanopyPath(canopyPath) : canopyPath,
  })

  return { data, isLoading, highlightEnabled, fieldProps }
}

/**
 * Hook for preview pages to listen for draft updates from the parent editor.
 * Returns both data and loading state.
 */
export const usePreviewData = <T,>(path: string, initialData: T): { data: T; isLoading: any } => {
  const [data, setData] = useState<T>(initialData)
  const [isLoading, setIsLoading] = useState<any>({})

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as DraftUpdateMessage
      if (!msg || msg.type !== CANOPY_PREVIEW_MESSAGE || msg.path !== path) return
      setData(msg.data as T)
      if (msg.isLoading !== undefined) {
        setIsLoading(msg.isLoading)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [path])

  return { data, isLoading }
}

/**
 * Hook for preview pages to listen for highlight mode and toggle an outline on clickable elements.
 */
export const usePreviewHighlight = () => {
  const [enabled, setEnabled] = useState(false)

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
    const handler = (event: MessageEvent) => {
      const msg = event.data as HighlightMessage
      if (msg?.type !== CANOPY_PREVIEW_HIGHLIGHT) return
      setEnabled(Boolean(msg.enabled))
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return enabled
}

/**
 * Hook for preview pages to emit focus messages when elements with data-canopy-path are clicked.
 */
export const usePreviewFocusEmitter = (entryId: string) => {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const el = target.closest<HTMLElement>('[data-canopy-path]')
      const fieldPath = el?.dataset.canopyPath
      if (!fieldPath || !window.parent) return
      const msg: PreviewFocusMessage = {
        type: CANOPY_PREVIEW_FOCUS,
        entryId,
        fieldPath,
      }
      window.parent.postMessage(msg, '*')
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [entryId])
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
}: {
  src: string
  path: string
  data?: unknown
  isLoading?: unknown
  className?: string
  style?: CSSProperties
  highlightEnabled?: boolean
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const post = () => {
    if (data === undefined) return
    sendDraftUpdate(iframeRef.current, { type: CANOPY_PREVIEW_MESSAGE, path, data, isLoading })
  }
  const postHighlight = () => {
    if (!iframeRef.current?.contentWindow) return
    const msg: HighlightMessage = {
      type: CANOPY_PREVIEW_HIGHLIGHT,
      enabled: Boolean(highlightEnabled),
    }
    iframeRef.current.contentWindow.postMessage(msg, '*')
  }

  useEffect(() => {
    post()
  }, [data, isLoading])

  useEffect(() => {
    postHighlight()
  }, [highlightEnabled])

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className={className}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        border: 'none',
        ...style,
      }}
      onLoad={() => {
        post()
        postHighlight()
      }}
    />
  )
}
