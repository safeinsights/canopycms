import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type History = typeof import('./editor-history')
let history: History

const KEY = 'canopyHistory'
const stamp = () => (window.history.state as Record<string, { run: string; position: number }>)[KEY]
const popped = () =>
  new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
const go = async (delta: number) => {
  const landed = popped()
  window.history.go(delta)
  await landed
}

beforeEach(async () => {
  vi.resetModules()
  history = await import('./editor-history')
  window.history.replaceState(null, '', '/edit?entry=a')
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('editor history', () => {
  it("pushes only its stamp, so a host's patched history methods add their own keys", () => {
    window.history.replaceState({ __NA: true, tree: ['host'] }, '', '/edit?entry=a')
    history.markEditorHistoryStart()
    const push = vi.spyOn(window.history, 'pushState')

    history.writeEditorUrl('/edit?entry=b', true)

    expect(push).toHaveBeenCalledWith(
      { [KEY]: { run: expect.any(String), position: 1 } },
      '',
      '/edit?entry=b',
    )
  })

  it("replaces without Next.js's keys, keeping any other state on the entry", () => {
    window.history.replaceState({ __NA: true, other: 1 }, '', '/edit?entry=a')
    history.markEditorHistoryStart()

    history.writeEditorUrl('/edit?entry=b', false)

    expect(window.history.state).toEqual({
      other: 1,
      [KEY]: { run: expect.any(String), position: 0 },
    })
  })

  it('stamps the entry it opened on in place, keeping its state', () => {
    window.history.replaceState({ __NA: true, tree: ['host'] }, '', '/edit?entry=a')

    history.markEditorHistoryStart()

    expect(window.history.state).toEqual({
      __NA: true,
      tree: ['host'],
      [KEY]: { run: expect.any(String), position: 0 },
    })
  })

  it('never writes the URL already shown, however its query is encoded', () => {
    window.history.replaceState(null, '', '/edit?entry=content/posts/a')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')

    history.writeEditorUrl('/edit?entry=content%2Fposts%2Fa', true)

    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('carries on from the last known position when a host write drops the stamp', () => {
    history.markEditorHistoryStart()
    history.writeEditorUrl('/edit?entry=b', true)
    history.writeEditorUrl('/edit?entry=c', true)
    window.history.replaceState({ __NA: true }, '', window.location.href)

    history.writeEditorUrl('/edit?entry=d', true)

    expect(stamp().position).toBe(3)
  })

  it('reports how far a Back moved, and ignores the popstate of its own undo only', async () => {
    history.markEditorHistoryStart()
    history.writeEditorUrl('/edit?entry=b', true)
    history.writeEditorUrl('/edit?entry=c', true)

    await go(-2)
    expect(history.recordHistoryMove()).toBe(-2)

    const landed = popped()
    history.undoHistoryMove(-2)
    await landed
    expect(history.recordHistoryMove()).toBeNull()
    expect(new URLSearchParams(window.location.search).get('entry')).toBe('c')

    await go(-1)
    expect(history.recordHistoryMove()).toBe(-1)
  })

  it('counts a popstate landing elsewhere than its undo as a move of its own', async () => {
    history.markEditorHistoryStart()
    history.writeEditorUrl('/edit?entry=b', true)
    history.writeEditorUrl('/edit?entry=c', true)
    await go(-2)
    history.recordHistoryMove()
    // The undo is asked for, but the user's Forward arrives first.
    vi.spyOn(window.history, 'go').mockImplementationOnce(() => {})
    history.undoHistoryMove(-2)

    await go(1)

    expect(history.recordHistoryMove()).toBe(1)
  })

  it('reports no distance across an entry whose stamp a host dropped', async () => {
    history.markEditorHistoryStart()
    history.writeEditorUrl('/edit?entry=b', true)
    history.writeEditorUrl('/edit?entry=c', true)
    window.history.replaceState({ __NA: true }, '', window.location.href)
    await go(-1)
    history.recordHistoryMove()
    await go(1)
    history.recordHistoryMove()
    history.writeEditorUrl('/edit?entry=d', true)
    history.writeEditorUrl('/edit?entry=e', true)

    await go(-3)

    expect(history.recordHistoryMove()).toBeUndefined()
  })
})
