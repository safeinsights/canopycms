import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Mocked so this stays a node-environment test: calling the wrapper as a function returns the
// element it would render, with no DOM.
vi.mock('canopycms/preview', () => ({ useCanopyPreview: vi.fn() }))

const { useCanopyPreview } = await import('canopycms/preview')
const { withCanopyPreview } = await import('./preview')

describe('withCanopyPreview', () => {
  it("renders the view with useCanopyPreview's live state for the initial data", async () => {
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
    vi.mocked(useCanopyPreview).mockReturnValue({ data: { title: 'Saved' } } as never)
    const Preview = withCanopyPreview(() => null)

    const element = Preview({ initialData: { title: 'Saved' } }) as ReactElement<
      Record<string, unknown>
    >

    expect(element.props.extras).toBeUndefined()
  })
})
