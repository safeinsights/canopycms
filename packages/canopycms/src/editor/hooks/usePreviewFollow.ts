import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { normalizeCanopyPath } from '../canopy-path'
import type { PreviewReveal } from '../PreviewFrame'
import { FORM_PANE_ID } from '../shell/PaneLayout'

/**
 * How long the form rests on one field before the preview follows, so tabbing through doesn't.
 * @internal Exported for tests.
 */
export const PREVIEW_FOLLOW_DELAY_MS = 250

/** Has the preview follow the form to a field; null while it doesn't follow. */
export const PreviewFollowContext = createContext<((canopyPath: string) => void) | null>(null)

export const usePreviewFollowRequest = (): ((canopyPath: string) => void) | null =>
  useContext(PreviewFollowContext)

export interface UsePreviewFollowReturn {
  /** The latest field to bring into view in the preview, for `PreviewFrame`'s `reveal`. */
  reveal: PreviewReveal | undefined
  /** Asks for a field, as a comment opening on it does; undefined while the preview doesn't follow. */
  follow: ((canopyPath: string) => void) | undefined
}

/**
 * The preview follows the form: a form field taking focus, or `follow` for one, asks the preview to
 * bring that field's element into view, once the form has rested on it for
 * `PREVIEW_FOLLOW_DELAY_MS`. A reveal belongs to one entry's page, so a change of entry drops it.
 */
export function usePreviewFollow({
  enabled,
  entryKey,
}: {
  enabled: boolean
  entryKey: string | undefined
}): UsePreviewFollowReturn {
  const [reveal, setReveal] = useState<PreviewReveal | undefined>(undefined)
  const timer = useRef<number | undefined>(undefined)
  const lastId = useRef(0)

  const follow = useCallback((canopyPath: string) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      lastId.current += 1
      setReveal({ path: normalizeCanopyPath(canopyPath), id: lastId.current })
    }, PREVIEW_FOLLOW_DELAY_MS)
  }, [])

  useEffect(() => {
    window.clearTimeout(timer.current)
    setReveal(undefined)
  }, [entryKey, enabled])

  useEffect(() => {
    if (!enabled) return
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest(`#${FORM_PANE_ID}`)) return
      const path = target.closest('[data-canopy-field]')?.getAttribute('data-canopy-field')
      if (path) follow(path)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [enabled, follow])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return { reveal, follow: enabled ? follow : undefined }
}
