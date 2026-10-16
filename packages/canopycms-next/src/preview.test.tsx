import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Mocked so this stays a node-environment test: calling the wrapper as a function returns the
// element it would render, with no DOM.
vi.mock('canopycms/preview', () => ({
  useCanopyPreview: vi.fn(),
  usePreviewAssetBaseGate: vi.fn(() => true),
}))

const { useCanopyPreview, usePreviewAssetBaseGate } = await import('canopycms/preview')
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

  describe("on createPreviewPage's route", () => {
    const routeProps = {
      initialData: { title: 'Saved' },
      previewAssetBase: '/api/canopycms/assets/raw',
    }
    // How `createPreviewPageFor` passes the prop, which `CanopyPreviewProps` does not declare.
    const renderOnRoute = (Preview: ReturnType<typeof withCanopyPreview<{ title: string }>>) =>
      (Preview as (props: typeof routeProps) => ReactElement<Record<string, unknown>>)(routeProps)

    it('holds the view back while the gate is shut', () => {
      vi.mocked(useCanopyPreview).mockReturnValue({ data: { title: 'Saved' } } as never)
      vi.mocked(usePreviewAssetBaseGate).mockReturnValueOnce(false)
      const View = vi.fn(() => null)

      const element = renderOnRoute(withCanopyPreview(View))

      expect(usePreviewAssetBaseGate).toHaveBeenCalledWith('/api/canopycms/assets/raw')
      expect(element.type).not.toBe(View)
      expect(element.props.children).toBeUndefined()
    })

    it('renders the view once the gate opens, without handing it the asset base', () => {
      const state = { data: { title: 'Draft' } }
      vi.mocked(useCanopyPreview).mockReturnValue(state as never)
      const View = () => null

      const element = renderOnRoute(withCanopyPreview(View))

      expect(element.type).toBe(View)
      expect(element.props).toEqual({ ...state, extras: undefined })
    })

    it('keeps the asset base out of the props adopter code writes against', () => {
      const Preview = withCanopyPreview<{ title: string }>(() => null)
      expect(() =>
        // @ts-expect-error `previewAssetBase` is not part of `CanopyPreviewProps`
        Preview({ initialData: { title: 'Saved' }, previewAssetBase: '/api/canopycms/assets/raw' }),
      ).not.toThrow()
    })
  })

  it('opens the gate at once on a public page, which passes no asset base', () => {
    vi.mocked(useCanopyPreview).mockReturnValue({ data: { title: 'Saved' } } as never)

    withCanopyPreview(() => null)({ initialData: { title: 'Saved' } })

    expect(usePreviewAssetBaseGate).toHaveBeenLastCalledWith(undefined)
  })
})
