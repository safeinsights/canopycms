import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CANOPY_PREVIEW_MESSAGE, useCanopyPreview } from './preview-bridge'

afterEach(() => cleanup())

const PreviewValue = ({ initialData, path }: { initialData: { value: string }; path?: string }) => {
  const { data } = useCanopyPreview<{ value: string }>({ initialData, path })
  return <div data-testid="value">{data.value}</div>
}

describe('useCanopyPreview', () => {
  it('uses the current location when path is omitted', async () => {
    window.history.pushState({}, '', '/posts/hello-world?branch=main')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/hello-world?branch=main',
          data: { value: 'updated' },
        },
      }),
    )

    await waitFor(() => expect(getByTestId('value').textContent).toBe('updated'))
  })

  it('prefers the provided path over the current location', async () => {
    window.history.pushState({}, '', '/posts/different?branch=main')
    const { getByTestId } = render(
      <PreviewValue initialData={{ value: 'initial' }} path="/posts/override?branch=main" />,
    )

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/override?branch=main',
          data: { value: 'updated' },
        },
      }),
    )

    await waitFor(() => expect(getByTestId('value').textContent).toBe('updated'))
  })
})
