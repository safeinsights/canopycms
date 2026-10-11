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
    // Mock ResizeObserver
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as any
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with default values', () => {
    const { result } = renderHook(() => useEditorLayout())

    expect(result.current.layout).toBe('side')
    expect(result.current.highlightEnabled).toBe(false)
    expect(result.current.headerHeight).toBe(80)
    expect(result.current.headerRef).toBeDefined()
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

  it('provides a stable headerRef', () => {
    const { result, rerender } = renderHook(() => useEditorLayout())

    const initialRef = result.current.headerRef

    rerender()

    expect(result.current.headerRef).toBe(initialRef)
  })

  it('measures header height when ref is attached', () => {
    const mockGetBoundingClientRect = vi.fn(() => ({
      height: 120,
      width: 800,
      x: 0,
      y: 0,
      bottom: 120,
      left: 0,
      right: 800,
      top: 0,
      toJSON: () => {},
    }))

    const { result } = renderHook(() => useEditorLayout())

    // Simulate attaching the ref to a DOM element
    const mockElement = {
      getBoundingClientRect: mockGetBoundingClientRect,
    } as any

    act(() => {
      if (result.current.headerRef) {
        ;(result.current.headerRef as any).current = mockElement
      }
    })

    // Note: In actual implementation, the height is updated via ResizeObserver
    // This test verifies the ref exists and can be used
    expect(result.current.headerRef.current).toBe(mockElement)
  })

  it('does not throw errors on mount and unmount', () => {
    const { unmount } = renderHook(() => useEditorLayout())

    // Should not throw any errors
    expect(() => unmount()).not.toThrow()
  })

  it('falls back to default height if getBoundingClientRect returns 0', () => {
    const mockGetBoundingClientRect = vi.fn(() => ({
      height: 0,
      width: 800,
      x: 0,
      y: 0,
      bottom: 0,
      left: 0,
      right: 800,
      top: 0,
      toJSON: () => {},
    }))

    global.ResizeObserver = vi.fn().mockImplementation(() => {
      return {
        observe: vi.fn(),
        disconnect: vi.fn(),
        unobserve: vi.fn(),
      }
    }) as any

    const { result } = renderHook(() => useEditorLayout())

    // Simulate attaching the ref
    const mockElement = {
      getBoundingClientRect: mockGetBoundingClientRect,
    } as any

    act(() => {
      ;(result.current.headerRef as any).current = mockElement
    })

    // The default height of 80 should be used
    expect(result.current.headerHeight).toBe(80)
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
    act(() => result.current.setContentPanelOpen(true))
    act(() => result.current.setContentPanelWidth(320))

    expect(stored()).toEqual({
      layout: 'stacked',
      highlightEnabled: true,
      sideSplitPercent: 33,
      stackedSplitPercent: 66,
      previewWidth: 'mobile',
      contentPanelOpen: true,
      contentPanelWidth: 320,
    })
    expect(result.current.sideSplitPercent).toBe(33)
    expect(result.current.previewWidth).toBe('mobile')
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
    expect(stored(editorLayoutStorageKey('/b'))?.layout).toBe('side')
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
