import { describe, expect, it, vi } from 'vitest'

// Mocked so this stays a node-environment test: the factory under test calls
// CanopyEditorPage at CALL time (not render time), so asserting what it was
// handed needs no DOM, no jsdom and no testing-library.
const canopyEditorPage = vi.fn(() => () => null)
vi.mock('canopycms/client', () => ({
  CanopyEditorPage: (...args: unknown[]) => canopyEditorPage(...(args as [])),
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

const { NextCanopyEditorPage } = await import('./client')

const config = { apiBase: '/api/canopycms' } as never

describe('NextCanopyEditorPage', () => {
  it('forwards customRenderers to CanopyEditorPage', () => {
    // Next is the primary target, so this wrapper is the entrypoint adopters
    // import. Accepting `customRenderers` only on the core CanopyEditorPage
    // left the extension point unreachable from the path every adopter uses
    // - and silently, since an ignored extra argument is not a type error at
    // the call site.
    const customRenderers = { number: () => null }

    NextCanopyEditorPage(config, customRenderers)

    expect(canopyEditorPage).toHaveBeenCalledWith(config, customRenderers)
  })

  it('still works with no customRenderers (the scaffolded call shape)', () => {
    canopyEditorPage.mockClear()

    NextCanopyEditorPage(config)

    expect(canopyEditorPage).toHaveBeenCalledWith(config, undefined)
  })
})
