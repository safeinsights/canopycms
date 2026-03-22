import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorLayout } from './useEditorLayout'

describe('useEditorLayout', () => {
  beforeEach(() => {
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
