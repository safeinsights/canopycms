import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  markEditorHistoryStart,
  recordHistoryMove,
  undoHistoryMove,
  writeEditorUrl,
} from './editor-history'

const KEY = 'canopyHistoryPosition'

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('editor history', () => {
  it("writes only its stamp, so a host's patched history methods add their own keys", () => {
    window.history.replaceState({ __NA: true, tree: ['host'] }, '', '/edit?entry=a')
    const push = vi.spyOn(window.history, 'pushState')

    writeEditorUrl('/edit?entry=b', true)

    expect(push).toHaveBeenCalledWith({ [KEY]: 1 }, '', '/edit?entry=b')
  })

  it('never writes the URL already shown, however its query is encoded', () => {
    window.history.replaceState(null, '', '/edit?entry=content/posts/a')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')

    writeEditorUrl('/edit?entry=content%2Fposts%2Fa', true)

    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('carries on from the last known position when a host write drops the stamp', () => {
    window.history.replaceState(null, '', '/edit?entry=a')
    markEditorHistoryStart()
    writeEditorUrl('/edit?entry=b', true)
    writeEditorUrl('/edit?entry=c', true)
    const atC = (window.history.state as Record<string, number>)[KEY]
    window.history.replaceState({ __NA: true }, '', window.location.href)

    writeEditorUrl('/edit?entry=d', true)

    expect(window.history.state).toEqual({ [KEY]: atC + 1 })
  })

  it('reports how far a Back moved, and ignores the popstate of its own undo only', async () => {
    window.history.replaceState(null, '', '/edit?entry=a')
    markEditorHistoryStart()
    writeEditorUrl('/edit?entry=b', true)
    writeEditorUrl('/edit?entry=c', true)
    const popped = () =>
      new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))

    let landed = popped()
    window.history.go(-2)
    await landed
    expect(recordHistoryMove()).toBe(-2)

    landed = popped()
    undoHistoryMove(-2)
    await landed
    expect(recordHistoryMove()).toBeNull()
    expect(new URLSearchParams(window.location.search).get('entry')).toBe('c')

    landed = popped()
    window.history.back()
    await landed
    expect(recordHistoryMove()).toBe(-1)
  })

  it('counts a popstate landing elsewhere than its undo as a move of its own', async () => {
    window.history.replaceState(null, '', '/edit?entry=a')
    markEditorHistoryStart()
    writeEditorUrl('/edit?entry=b', true)
    writeEditorUrl('/edit?entry=c', true)
    const popped = () =>
      new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
    let landed = popped()
    window.history.go(-2)
    await landed
    recordHistoryMove()
    // The undo is asked for, but the user's Forward arrives first.
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    undoHistoryMove(-2)
    go.mockRestore()

    landed = popped()
    window.history.forward()
    await landed

    expect(recordHistoryMove()).toBe(1)
  })
})
