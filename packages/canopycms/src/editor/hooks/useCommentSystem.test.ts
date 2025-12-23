import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommentSystem } from './useCommentSystem'
import type { EditorEntry } from '../Editor'
import type { CommentThread } from '../../comment-store'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useCommentSystem', () => {
  const mockEntry: EditorEntry = {
    id: 'entry1',
    label: 'Test Entry',
    collectionId: 'posts',
    collectionName: 'posts',
    slug: 'test',
    type: 'entry',
    apiPath: '/api/canopycms/main/content/posts/test',
    format: 'mdx',
    schema: [],
    previewSrc: 'preview-entry1',
  }

  const mockComments: CommentThread[] = [
    {
      id: 'thread1',
      type: 'field',
      entryId: 'entry1',
      canopyPath: 'title',
      comments: [{ id: 'c1', text: 'Field comment', author: 'user1', createdAt: new Date().toISOString() }],
      resolved: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'thread2',
      type: 'entry',
      entryId: 'entry1',
      comments: [{ id: 'c2', text: 'Entry comment', author: 'user1', createdAt: new Date().toISOString() }],
      resolved: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'thread3',
      type: 'branch',
      comments: [{ id: 'c3', text: 'Branch comment', author: 'user1', createdAt: new Date().toISOString() }],
      resolved: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]

  const mockReloadBranches = vi.fn()

  const defaultOptions = {
    branchName: 'main',
    selectedId: 'entry1',
    currentEntry: mockEntry,
    currentUser: 'user1',
    canResolveComments: true,
    onReloadBranches: mockReloadBranches,
    setSelectedId: vi.fn(),
    setBranchManagerOpen: vi.fn(),
  }

  beforeEach(() => {
    // Mock fetch with default successful response to handle automatic loadComments on mount
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { threads: [] } }),
    })
    mockReloadBranches.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with empty state', () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    expect(result.current.comments).toEqual([])
    expect(result.current.focusedFieldPath).toBeUndefined()
    expect(result.current.highlightThreadId).toBeUndefined()
    expect(result.current.commentsPanelOpen).toBe(false)
    expect(result.current.commentThreadPanelOpen).toBe(false)
    expect(result.current.activeCommentContext).toBeNull()
    expect(result.current.activeThreads).toEqual([])
    expect(result.current.activeContextLabel).toBe('')
  })

  it('loads comments successfully', async () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    // Override the default empty response with mockComments
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { threads: mockComments } }),
    })

    await act(async () => {
      await result.current.loadComments('main')
    })

    await waitFor(() => {
      expect(result.current.comments).toEqual(mockComments)
    })
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/main/comments')
  })

  it('handles load comments error gracefully', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    // Override the default mock for this specific test
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    await act(async () => {
      await result.current.loadComments('main')
    })

    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load comments:', 500)
    expect(result.current.comments).toEqual([])
    consoleErrorSpy.mockRestore()
  })

  it('loads comments when branchName changes', async () => {
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { threads: [] } }),
    })

    const { rerender } = renderHook((props) => useCommentSystem(props), {
      initialProps: defaultOptions,
    })

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/main/comments')
    })

    rerender({ ...defaultOptions, branchName: 'feature' })

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/feature/comments')
    })
  })

  it('adds field comment successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: mockComments } }),
      })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'field', 'entry1', 'title')
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/canopycms/main/comments',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Test comment',
          type: 'field',
          entryId: 'entry1',
          canopyPath: 'title',
          threadId: undefined,
        }),
      })
    )
    expect(mockReloadBranches).toHaveBeenCalled()
  })

  it('adds entry comment successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'entry', 'entry1')
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/canopycms/main/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'Test comment',
          type: 'entry',
          entryId: 'entry1',
          threadId: undefined,
        }),
      })
    )
  })

  it('adds branch comment successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'branch')
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/canopycms/main/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'Test comment',
          type: 'branch',
          threadId: undefined,
        }),
      })
    )
  })

  it('handles add comment error', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'field', 'entry1', 'title')
    })

    expect(mockReloadBranches).not.toHaveBeenCalled()
  })

  it('resolves thread successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await act(async () => {
      await result.current.handleResolveThread('thread1')
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/canopycms/main/comments/thread1/resolve',
      expect.objectContaining({
        method: 'POST',
      })
    )
    expect(mockReloadBranches).toHaveBeenCalled()
  })

  it('handles resolve thread error', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { threads: [] } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await act(async () => {
      await result.current.handleResolveThread('thread1')
    })

    expect(mockReloadBranches).not.toHaveBeenCalled()
  })

  it('computes activeThreads for field context', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { threads: mockComments } }),
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await waitFor(() => {
      expect(result.current.comments).toHaveLength(3)
    })

    act(() => {
      result.current.setActiveCommentContext({ type: 'field', canopyPath: 'title' })
    })

    expect(result.current.activeThreads).toHaveLength(1)
    expect(result.current.activeThreads[0].id).toBe('thread1')
    expect(result.current.activeContextLabel).toBe('title')
  })

  it('computes activeThreads for entry context', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { threads: mockComments } }),
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await waitFor(() => {
      expect(result.current.comments).toHaveLength(3)
    })

    act(() => {
      result.current.setActiveCommentContext({ type: 'entry' })
    })

    expect(result.current.activeThreads).toHaveLength(1)
    expect(result.current.activeThreads[0].id).toBe('thread2')
    expect(result.current.activeContextLabel).toBe('entry1')
  })

  it('computes activeThreads for branch context', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { threads: mockComments } }),
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    await waitFor(() => {
      expect(result.current.comments).toHaveLength(3)
    })

    act(() => {
      result.current.setActiveCommentContext({ type: 'branch' })
    })

    expect(result.current.activeThreads).toHaveLength(1)
    expect(result.current.activeThreads[0].id).toBe('thread3')
    expect(result.current.activeContextLabel).toBe('main')
  })

  it('returns empty activeThreads when no context is set', () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    expect(result.current.activeThreads).toEqual([])
    expect(result.current.activeContextLabel).toBe('')
  })

  it('handles preview frame focus message', async () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    // Create a mock DOM element
    const mockElement = document.createElement('div')
    mockElement.setAttribute('data-canopy-field', 'title')
    mockElement.scrollIntoView = vi.fn()
    document.body.appendChild(mockElement)

    // Simulate preview frame message
    const message = new MessageEvent('message', {
      data: {
        type: 'canopycms:preview:focus',
        entryId: 'preview-entry1',
        fieldPath: 'title',
      },
    })

    act(() => {
      window.dispatchEvent(message)
    })

    await waitFor(() => {
      expect(mockElement.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
      })
    })

    await waitFor(() => {
      expect(result.current.focusedFieldPath).toBe('title')
    })

    // Clean up
    document.body.removeChild(mockElement)
  })

  it('ignores preview frame message for wrong entry', () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    const mockElement = document.createElement('div')
    mockElement.setAttribute('data-canopy-field', 'title')
    mockElement.scrollIntoView = vi.fn()
    document.body.appendChild(mockElement)

    const message = new MessageEvent('message', {
      data: {
        type: 'canopycms:preview:focus',
        entryId: 'wrong-entry',
        fieldPath: 'title',
      },
    })

    act(() => {
      window.dispatchEvent(message)
    })

    expect(mockElement.scrollIntoView).not.toHaveBeenCalled()
    expect(result.current.focusedFieldPath).toBeUndefined()

    document.body.removeChild(mockElement)
  })

  it('updates state setters correctly', () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions))

    act(() => {
      result.current.setFocusedFieldPath('test-path')
    })
    expect(result.current.focusedFieldPath).toBe('test-path')

    act(() => {
      result.current.setHighlightThreadId('thread-123')
    })
    expect(result.current.highlightThreadId).toBe('thread-123')

    act(() => {
      result.current.setCommentsPanelOpen(true)
    })
    expect(result.current.commentsPanelOpen).toBe(true)

    act(() => {
      result.current.setCommentThreadPanelOpen(true)
    })
    expect(result.current.commentThreadPanelOpen).toBe(true)

    act(() => {
      result.current.setActiveCommentContext({ type: 'field', canopyPath: 'title' })
    })
    expect(result.current.activeCommentContext).toEqual({ type: 'field', canopyPath: 'title' })
  })

  it('does not add comment when branchName is empty', async () => {
    const { result } = renderHook(() =>
      useCommentSystem({ ...defaultOptions, branchName: '' })
    )

    await act(async () => {
      await result.current.handleAddComment('Test', 'field', 'entry1', 'title')
    })

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/comments'),
      expect.anything()
    )
  })

  it('does not resolve thread when branchName is empty', async () => {
    const { result } = renderHook(() =>
      useCommentSystem({ ...defaultOptions, branchName: '' })
    )

    await act(async () => {
      await result.current.handleResolveThread('thread1')
    })

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/resolve'),
      expect.anything()
    )
  })
})
