import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EDITOR_LAYOUT_PREFS,
  editorLayoutStorageKey,
  parseEditorLayoutPrefs,
  useEditorLayout,
} from './useEditorLayout'

describe('useEditorLayout', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with default values', () => {
    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('side')
    expect(result.current.highlightEnabled).toBe(false)
  })

  it('toggles layout between side and stacked', () => {
    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('side')

    act(() => {
      result.current.setLayout('stacked')
    })

    expect(result.current.layout).toBe('stacked')

    act(() => {
      result.current.setLayout('side')
    })

    expect(result.current.layout).toBe('side')
  })

  it('toggles highlight enabled', () => {
    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.highlightEnabled).toBe(false)

    act(() => {
      result.current.setHighlightEnabled(true)
    })

    expect(result.current.highlightEnabled).toBe(true)

    act(() => {
      result.current.setHighlightEnabled(false)
    })

    expect(result.current.highlightEnabled).toBe(false)
  })

  it('does not throw errors on mount and unmount', () => {
    const { unmount } = renderHook(() => useEditorLayout())

    // Should not throw any errors
    expect(() => unmount()).not.toThrow()
  })
})

describe('useEditorLayout persistence', () => {
  const KEY = editorLayoutStorageKey()
  const stored = (key = KEY): Record<string, unknown> | null => {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
  }

  beforeEach(() => {
    window.localStorage.clear()
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('derives the default key from the deployment prefix', () => {
    expect(editorLayoutStorageKey()).toBe('canopycms:editor-layout:/')
    expect(editorLayoutStorageKey('')).toBe('canopycms:editor-layout:/')
    expect(editorLayoutStorageKey('/cms')).toBe('canopycms:editor-layout:/cms')
  })

  it('starts from the defaults with empty storage', () => {
    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('side')
    expect(result.current.highlightEnabled).toBe(false)
    expect(result.current.sideSplitPercent).toBe(52)
    expect(result.current.stackedSplitPercent).toBe(58)
    expect(result.current.previewWidth).toBe('fit')
    expect(result.current.siteChrome).toBe(false)
    expect(result.current.contentPanelOpen).toBe(false)
    expect(result.current.contentPanelWidth).toBe(280)
  })

  it('restores stored preferences after mount', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        layout: 'stacked',
        highlightEnabled: true,
        sideSplitPercent: 40,
        stackedSplitPercent: 70,
        previewWidth: 'tablet',
        siteChrome: true,
        contentPanelOpen: true,
        contentPanelWidth: 300,
      }),
    )

    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('stacked')
    expect(result.current.highlightEnabled).toBe(true)
    expect(result.current.sideSplitPercent).toBe(40)
    expect(result.current.stackedSplitPercent).toBe(70)
    expect(result.current.previewWidth).toBe('tablet')
    expect(result.current.siteChrome).toBe(true)
    expect(result.current.contentPanelOpen).toBe(true)
    expect(result.current.contentPanelWidth).toBe(300)
  })

  it('writes each setter to the storage key as one JSON object', () => {
    const { result } = renderHook(() => useEditorLayout())

    act(() => result.current.setLayout('stacked'))
    expect(stored()?.layout).toBe('stacked')

    act(() => result.current.setHighlightEnabled(true))
    expect(stored()?.highlightEnabled).toBe(true)

    act(() => result.current.setSplitPercent('side', 33))
    act(() => result.current.setSplitPercent('stacked', 66))
    expect(stored()?.sideSplitPercent).toBe(33)
    expect(stored()?.stackedSplitPercent).toBe(66)

    act(() => result.current.setPreviewWidth('mobile'))
    act(() => result.current.setSiteChrome(true))
    act(() => result.current.setContentPanelOpen(true))
    act(() => result.current.setContentPanelWidth(320))

    expect(stored()).toEqual({
      layout: 'stacked',
      highlightEnabled: true,
      sideSplitPercent: 33,
      stackedSplitPercent: 66,
      previewWidth: 'mobile',
      siteChrome: true,
      contentPanelOpen: true,
      contentPanelWidth: 320,
    })
    expect(result.current.sideSplitPercent).toBe(33)
    expect(result.current.previewWidth).toBe('mobile')
    expect(result.current.siteChrome).toBe(true)
  })

  it('clamps split percents and the content-panel width, and ignores non-finite values', () => {
    const { result } = renderHook(() => useEditorLayout())

    act(() => result.current.setSplitPercent('side', 5))
    expect(result.current.sideSplitPercent).toBe(15)
    act(() => result.current.setSplitPercent('side', 99))
    expect(result.current.sideSplitPercent).toBe(85)
    act(() => result.current.setSplitPercent('stacked', 1000))
    expect(result.current.stackedSplitPercent).toBe(85)
    act(() => result.current.setContentPanelWidth(100))
    expect(result.current.contentPanelWidth).toBe(240)
    act(() => result.current.setContentPanelWidth(900))
    expect(result.current.contentPanelWidth).toBe(400)

    act(() => result.current.setSplitPercent('side', Number.NaN))
    act(() => result.current.setContentPanelWidth(Number.POSITIVE_INFINITY))
    expect(result.current.sideSplitPercent).toBe(85)
    expect(result.current.contentPanelWidth).toBe(400)
  })

  it('keeps preferences under different keys apart', () => {
    const a = renderHook(() => useEditorLayout({ storageKey: editorLayoutStorageKey('/a') }))
    const b = renderHook(() => useEditorLayout({ storageKey: editorLayoutStorageKey('/b') }))

    act(() => a.result.current.setLayout('stacked'))

    expect(a.result.current.layout).toBe('stacked')
    expect(b.result.current.layout).toBe('side')
    expect(stored(editorLayoutStorageKey('/a'))?.layout).toBe('stacked')
    expect(stored(editorLayoutStorageKey('/b'))?.layout).toBeUndefined()
  })

  it("leaves another editor instance's layout alone when one changes it", () => {
    const key = editorLayoutStorageKey('/shared')
    const a = renderHook(() => useEditorLayout({ storageKey: key }))
    const b = renderHook(() => useEditorLayout({ storageKey: key }))

    act(() => a.result.current.setLayout('stacked'))

    expect(stored(key)?.layout).toBe('stacked')
    expect(b.result.current.layout).toBe('side')
  })

  it('falls back to defaults for corrupt JSON', () => {
    window.localStorage.setItem(KEY, '{not json')

    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('side')
    expect(result.current.sideSplitPercent).toBe(52)
  })

  it('keeps the valid fields of a partly invalid object', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        layout: 'diagonal',
        highlightEnabled: true,
        sideSplitPercent: 'wide',
        stackedSplitPercent: 1,
        previewWidth: 'tablet',
        contentPanelOpen: 'yes',
      }),
    )

    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('side')
    expect(result.current.highlightEnabled).toBe(true)
    expect(result.current.sideSplitPercent).toBe(52)
    expect(result.current.stackedSplitPercent).toBe(15)
    expect(result.current.previewWidth).toBe('tablet')
    expect(result.current.contentPanelOpen).toBe(false)
    expect(result.current.contentPanelWidth).toBe(280)
  })

  it('still works in memory when localStorage reads and writes throw', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    const { result } = renderHook(() => useEditorLayout())
    expect(result.current.layout).toBe('side')

    act(() => result.current.setLayout('stacked'))
    act(() => result.current.setSplitPercent('stacked', 61))

    expect(result.current.layout).toBe('stacked')
    expect(result.current.stackedSplitPercent).toBe(61)
  })
})

describe('useEditorLayout - default layout', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  const stored = (): Record<string, unknown> =>
    JSON.parse(window.localStorage.getItem(editorLayoutStorageKey()) ?? '{}')

  it('follows defaultLayout until the user picks a layout, then keeps the pick', () => {
    const { result, rerender } = renderHook(
      ({ defaultLayout }: { defaultLayout: 'side' | 'stacked' }) =>
        useEditorLayout({ defaultLayout }),
      { initialProps: { defaultLayout: 'stacked' } },
    )
    expect(result.current.layout).toBe('stacked')
    act(() => result.current.setHighlightEnabled(true))
    rerender({ defaultLayout: 'side' })
    expect(result.current.layout).toBe('side')
    expect(stored()?.layout).toBeUndefined()

    act(() => result.current.setLayout('stacked'))
    rerender({ defaultLayout: 'side' })
    expect(result.current.layout).toBe('stacked')
    expect(stored()?.layout).toBe('stacked')
  })
})

describe('parseEditorLayoutPrefs', () => {
  it('returns the defaults for absent, empty, or non-object input', () => {
    expect(parseEditorLayoutPrefs(undefined)).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS)
    expect(parseEditorLayoutPrefs('')).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS)
    expect(parseEditorLayoutPrefs('null')).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS)
    expect(parseEditorLayoutPrefs('[1,2]')).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS)
    expect(parseEditorLayoutPrefs('"stacked"')).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS)
    expect(parseEditorLayoutPrefs('{oops')).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS)
  })

  it('validates each field independently and clamps numbers', () => {
    expect(
      parseEditorLayoutPrefs(
        JSON.stringify({
          layout: 'stacked',
          highlightEnabled: 1,
          sideSplitPercent: 500,
          stackedSplitPercent: null,
          previewWidth: 'huge',
          siteChrome: 'yes',
          contentPanelOpen: true,
          contentPanelWidth: 10,
        }),
      ),
    ).toEqual({
      layout: 'stacked',
      highlightEnabled: false,
      sideSplitPercent: 85,
      stackedSplitPercent: 58,
      previewWidth: 'fit',
      siteChrome: false,
      contentPanelOpen: true,
      contentPanelWidth: 240,
    })
  })

  it('ignores keys inherited from Object.prototype and unknown keys', () => {
    expect(parseEditorLayoutPrefs('{"__proto__":{"layout":"stacked"},"extra":1}')).toEqual(
      DEFAULT_EDITOR_LAYOUT_PREFS,
    )
  })
})
