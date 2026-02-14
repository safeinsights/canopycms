import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommentSystem } from './useCommentSystem'
import type { EditorEntry } from '../Editor'
import type { CommentThread } from '../../comment-store'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, setupMockConsole, createApiClientWrapper } from './__test__/test-utils'

// Mock the API client module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useCommentSystem', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  const mockEntry: EditorEntry = {
    path: 'entry1',
    label: 'Test Entry',
    collectionId: 'posts',
    collectionName: 'posts',
    slug: 'test',
    type: 'entry',
    apiPath: '/api/canopycms/main/content/posts/test',
    format: 'mdx',
    schema: [],
    previewSrc: 'preview-entry1',
    contentId: 'test123456789',
  }

  const mockComments: CommentThread[] = [
    {
      id: 'thread1',
      type: 'field',
      entryPath: 'entry1',
      canopyPath: 'title',
      comments: [
        {
          id: 'c1',
          threadId: 't1',
          text: 'Field comment',
          userId: 'user1',
          timestamp: new Date().toISOString(),
        },
      ],
      resolved: false,
      createdAt: new Date().toISOString(),
      authorId: 'user1',
    },
    {
      id: 'thread2',
      type: 'entry',
      entryPath: 'entry1',
      comments: [
        {
          id: 'c2',
          threadId: 't2',
          text: 'Entry comment',
          userId: 'user1',
          timestamp: new Date().toISOString(),
        },
      ],
      resolved: false,
      createdAt: new Date().toISOString(),
      authorId: 'user1',
    },
    {
      id: 'thread3',
      type: 'branch',
      comments: [
        {
          id: 'c3',
          threadId: 't3',
          text: 'Branch comment',
          userId: 'user1',
          timestamp: new Date().toISOString(),
        },
      ],
      resolved: false,
      createdAt: new Date().toISOString(),
      authorId: 'user1',
    },
  ]

  const mockReloadBranches = vi.fn()

  const defaultOptions = {
    branchName: 'main',
    selectedPath: 'entry1',
    currentEntry: mockEntry,
    currentUser: 'user1',
    canResolveComments: true,
    onReloadBranches: mockReloadBranches,
    setSelectedPath: vi.fn(),
    setBranchManagerOpen: vi.fn(),
  }

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
    // Mock default response for automatic loadComments on mount
    mockClient.comments.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { threads: [] },
    })
    mockReloadBranches.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('initializes with empty state', () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

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
    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    // Override the default empty response with mockComments
    mockClient.comments.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { threads: mockComments },
    })

    await act(async () => {
      await result.current.loadComments('main')
    })

    await waitFor(() => {
      expect(result.current.comments).toEqual(mockComments)
    })
    expect(mockClient.comments.list).toHaveBeenCalledWith({ branch: 'main' })
  })

  it('handles load comments error gracefully', async () => {
    const { error, restore } = setupMockConsole(['error'])

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    // Override the default mock for this specific test
    mockClient.comments.list.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    await act(async () => {
      await result.current.loadComments('main')
    })

    expect(error).toHaveBeenCalledWith('Failed to load comments:', 500)
    expect(result.current.comments).toEqual([])
    restore()
  })

  it('loads comments when branchName changes', async () => {
    mockClient.comments.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { threads: [] },
    })

    const { rerender } = renderHook((props) => useCommentSystem(props), {
      initialProps: defaultOptions,
      wrapper,
    })

    await waitFor(() => {
      expect(mockClient.comments.list).toHaveBeenCalledWith({ branch: 'main' })
    })

    rerender({ ...defaultOptions, branchName: 'feature' })

    await waitFor(() => {
      expect(mockClient.comments.list).toHaveBeenCalledWith({ branch: 'feature' })
    })
  })

  it('adds field comment successfully', async () => {
    mockClient.comments.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: mockComments },
      })

    mockClient.comments.add.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'field', 'entry1', 'title')
    })

    expect(mockClient.comments.add).toHaveBeenCalledWith(
      { branch: 'main' },
      {
        text: 'Test comment',
        type: 'field',
        entryPath: 'entry1',
        canopyPath: 'title',
        threadId: undefined,
      },
    )
    // Branch summaries auto-update via useMemo watching comments
    // No need to reload branches explicitly
  })

  it('adds entry comment successfully', async () => {
    mockClient.comments.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })

    mockClient.comments.add.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'entry', 'entry1')
    })

    expect(mockClient.comments.add).toHaveBeenCalledWith(
      { branch: 'main' },
      {
        text: 'Test comment',
        type: 'entry',
        entryPath: 'entry1',
        threadId: undefined,
      },
    )
  })

  it('adds branch comment successfully', async () => {
    mockClient.comments.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })

    mockClient.comments.add.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'branch')
    })

    expect(mockClient.comments.add).toHaveBeenCalledWith(
      { branch: 'main' },
      {
        text: 'Test comment',
        type: 'branch',
        threadId: undefined,
      },
    )
  })

  it('handles add comment error', async () => {
    mockClient.comments.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { threads: [] },
    })

    mockClient.comments.add.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleAddComment('Test comment', 'field', 'entry1', 'title')
    })

    expect(mockReloadBranches).not.toHaveBeenCalled()
  })

  it('resolves thread successfully', async () => {
    mockClient.comments.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { threads: [] },
      })

    mockClient.comments.resolve.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleResolveThread('thread1')
    })

    expect(mockClient.comments.resolve).toHaveBeenCalledWith({
      branch: 'main',
      threadId: 'thread1',
    })
    // Branch summaries auto-update via useMemo watching comments
    // No need to reload branches explicitly
  })

  it('handles resolve thread error', async () => {
    mockClient.comments.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { threads: [] },
    })

    mockClient.comments.resolve.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleResolveThread('thread1')
    })

    expect(mockReloadBranches).not.toHaveBeenCalled()
  })

  it('computes activeThreads for field context', async () => {
    mockClient.comments.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { threads: mockComments },
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

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
    mockClient.comments.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { threads: mockComments },
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

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
    mockClient.comments.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { threads: mockComments },
    })

    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

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
    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    expect(result.current.activeThreads).toEqual([])
    expect(result.current.activeContextLabel).toBe('')
  })

  it('handles preview frame focus message', async () => {
    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    // Create a mock DOM element
    const mockElement = document.createElement('div')
    mockElement.setAttribute('data-canopy-field', 'title')
    mockElement.scrollIntoView = vi.fn()
    document.body.appendChild(mockElement)

    // Simulate preview frame message
    const message = new MessageEvent('message', {
      data: {
        type: 'canopycms:preview:focus',
        entryPath: 'preview-entry1',
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
    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

    const mockElement = document.createElement('div')
    mockElement.setAttribute('data-canopy-field', 'title')
    mockElement.scrollIntoView = vi.fn()
    document.body.appendChild(mockElement)

    const message = new MessageEvent('message', {
      data: {
        type: 'canopycms:preview:focus',
        entryPath: 'wrong-entry',
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
    const { result } = renderHook(() => useCommentSystem(defaultOptions), { wrapper })

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
    const { result } = renderHook(() => useCommentSystem({ ...defaultOptions, branchName: '' }), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleAddComment('Test', 'field', 'entry1', 'title')
    })

    expect(mockClient.comments.add).not.toHaveBeenCalled()
  })

  it('does not resolve thread when branchName is empty', async () => {
    const { result } = renderHook(() => useCommentSystem({ ...defaultOptions, branchName: '' }), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleResolveThread('thread1')
    })

    expect(mockClient.comments.resolve).not.toHaveBeenCalled()
  })
})
