import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Mocked so this stays a node-environment test: the factory under test calls
// CanopyEditorPage at CALL time (not render time), so asserting what it was
// handed needs no DOM, no jsdom and no testing-library.
const canopyEditorPage = vi.fn(() => () => null)
vi.mock('canopycms/client', () => ({
  CanopyEditorPage: (...args: unknown[]) => canopyEditorPage(...(args as [])),
  useCanopyPreview: vi.fn(),
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

describe('withCanopyPreview', () => {
  it("renders the view with useCanopyPreview's live state for the initial data", async () => {
    const { useCanopyPreview } = await import('canopycms/client')
    const { withCanopyPreview } = await import('./client')
    const state = { data: { title: 'Draft' }, isLoading: {}, highlightEnabled: false }
    vi.mocked(useCanopyPreview).mockReturnValue(state as never)
    const View = () => null
    const Preview = withCanopyPreview(View)

    const element = Preview({
      initialData: { title: 'Saved' },
      editorOrigin: 'https://cms.example.com',
    }) as ReactElement<Record<string, unknown>>

    expect(useCanopyPreview).toHaveBeenCalledWith({
      initialData: { title: 'Saved' },
      editorOrigin: 'https://cms.example.com',
    })
    expect(element.type).toBe(View)
    expect(element.props).toEqual(state)
  })

  it('hands the view its extras as one prop, which cannot shadow the hook result', async () => {
    const { useCanopyPreview } = await import('canopycms/client')
    const { withCanopyPreview } = await import('./client')
    const state = { data: { title: 'Draft' }, isLoading: {}, highlightEnabled: false }
    vi.mocked(useCanopyPreview).mockReturnValue(state as never)
    const View = () => null
    const Preview = withCanopyPreview<{ title: string }, { data: string; fieldProps: string }>(View)
    const extras = { data: 'from the loader', fieldProps: 'also the loader' }

    const element = Preview({ initialData: { title: 'Saved' }, extras }) as ReactElement<
      Record<string, unknown>
    >

    expect(element.props.data).toEqual({ title: 'Draft' })
    expect(element.props.fieldProps).toBeUndefined()
    expect(element.props.extras).toBe(extras)
  })

  it('passes no extras when none are given, as on a public page', async () => {
    const { useCanopyPreview } = await import('canopycms/client')
    const { withCanopyPreview } = await import('./client')
    vi.mocked(useCanopyPreview).mockReturnValue({ data: { title: 'Saved' } } as never)
    const Preview = withCanopyPreview(() => null)

    const element = Preview({ initialData: { title: 'Saved' } }) as ReactElement<
      Record<string, unknown>
    >

    expect(element.props.extras).toBeUndefined()
  })
})
