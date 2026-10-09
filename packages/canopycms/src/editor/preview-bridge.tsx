'use client'

/**
 * The preview bridge's protocol and its host-page side: the hooks a framed page runs. Served to
 * hosts through `canopycms/preview`, so everything it reaches stays free of CSS and editor UI
 * (`pnpm lint:bundle`); the editor's side is `PreviewFrame.tsx`.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

import type { ResolvedReferenceMeta } from '../entry-schema'
import { createFieldProps } from './field-props'
import { setPreviewAssetBase } from './preview-asset-base'
import { isSamePreviewPath } from './preview-path'
import { readAssetBase } from './raw-asset-base'

export const CANOPY_PREVIEW_MESSAGE = 'canopycms:draft:update'
export const CANOPY_PREVIEW_FOCUS = 'canopycms:preview:focus'
export const CANOPY_PREVIEW_HIGHLIGHT = 'canopycms:preview:highlight'
export const CANOPY_PREVIEW_READY = 'canopycms:preview:ready'
export const CANOPY_PREVIEW_ERROR = 'canopycms:preview:error'
export const CANOPY_PREVIEW_MARKS = 'canopycms:preview:marks'

/**
 * The shape of the preview's `isLoading` for data of type `T`: a `boolean` at each reference
 * position, `true` while the editor is still resolving that reference, under the same keys and
 * indexes as the data. A reference typed by `resolvedSchema` is recognized by its resolved or
 * `unavailable` shape; any other non-object leaf may be an untyped reference, so it is a
 * `boolean` too. Every key is optional because only reference positions are present, and nothing
 * is before the first draft arrives.
 */
export type PreviewLoadingState<T> = T extends readonly (infer U)[]
  ? PreviewLoadingState<NonNullable<U>>[]
  : T extends ResolvedReferenceMeta | { unavailable: true }
    ? boolean
    : T extends object
      ? { [K in keyof T]?: PreviewLoadingState<NonNullable<T[K]>> }
      : boolean

export interface DraftUpdateMessage {
  type: typeof CANOPY_PREVIEW_MESSAGE
  path: string
  data?: unknown
  isLoading?: unknown
  /** The editor's authenticated asset route; see `PreviewFrame`'s `assetBase`. */
  assetBase?: unknown
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

/** The most distinct mark paths one report carries, and the longest path it carries. */
export const MARK_REPORT_LIMITS = { paths: 500, pathLength: 512 } as const

/**
 * Preview → editor, while highlighting is on: how many `data-canopy-path` elements the page has,
 * so the editor can say when there is nothing to outline, and their distinct paths as the page
 * spells them, within `MARK_REPORT_LIMITS`, so it can say which name no field. An older bridge
 * sends no report, and one before `paths` sends only the count.
 */
export interface PreviewMarksMessage {
  type: typeof CANOPY_PREVIEW_MARKS
  count: number
  paths?: string[]
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

  const fieldProps = createFieldProps<T>()

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
): { data: T; isLoading: PreviewLoadingState<T> } => {
  const [data, setData] = useState<T>(initialData)
  // Every key of the loading state is optional, so an empty object is a valid one.
  const [isLoading, setIsLoading] = useState<PreviewLoadingState<T>>({} as PreviewLoadingState<T>)
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
        setIsLoading(msg.isLoading as PreviewLoadingState<T>)
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

/** React 18 warns about a layout effect in a server render, where no effect runs. */
const useBrowserLayoutEffect: typeof useLayoutEffect = (effect, deps) =>
  (typeof window === 'undefined' ? useEffect : useLayoutEffect)(effect, deps)

/**
 * Holds a `createPreviewPage` view back until hydration commits, then stores `assetBase` and opens
 * before paint: the server HTML has no public `/assets/t/` URL and nothing to mismatch. A draft's
 * prefix still wins, since drafts follow the ready message `usePreviewData` posts from a passive
 * effect. With no `assetBase` (a public page) it is open from the start.
 * @internal `withCanopyPreview` is its only caller.
 */
export const usePreviewAssetBaseGate = (assetBase: unknown): boolean => {
  const held = assetBase !== undefined
  const [open, setOpen] = useState(!held)
  useBrowserLayoutEffect(() => {
    if (open) return
    setPreviewAssetBase(readAssetBase(assetBase))
    setOpen(true)
  }, [open, assetBase])
  return open
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

  // Reported after the render that turned highlighting on, then again whenever the marks change
  // (a draft, or content rendered after hydration), so the editor's note keeps up with the page.
  useEffect(() => {
    if (!enabled || window.parent === window) return
    const target = resolveMessageOrigin(editorOrigin)
    if (isOpaqueOrigin(target)) return
    let reported: string | undefined
    const report = () => {
      const marks = document.querySelectorAll<HTMLElement>('[data-canopy-path]')
      const paths = new Set<string>()
      for (const mark of marks) {
        if (paths.size === MARK_REPORT_LIMITS.paths) break
        const path = mark.getAttribute('data-canopy-path') ?? ''
        if (path.length <= MARK_REPORT_LIMITS.pathLength) paths.add(path)
      }
      const msg: PreviewMarksMessage = {
        type: CANOPY_PREVIEW_MARKS,
        count: marks.length,
        paths: [...paths],
      }
      const key = JSON.stringify([msg.count, msg.paths])
      if (key === reported) return
      reported = key
      window.parent.postMessage(msg, target)
    }
    report()
    // A trailing throttle, so steady DOM churn cannot hold the report back, on a timer rather
    // than requestAnimationFrame, which a hidden frame never runs.
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = undefined
        report()
      }, 100)
    })
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ['data-canopy-path'],
    })
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [enabled, editorOrigin])

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
