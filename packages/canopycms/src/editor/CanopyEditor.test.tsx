import React from 'react'

import { describe, expect, it, vi } from 'vitest'

import { flattenSchema } from '../config'
import type { EditorProps } from './Editor'
import { CanopyEditor } from './CanopyEditor'

let capturedProps: EditorProps | undefined

vi.mock('./Editor', () => {
  return {
    __esModule: true,
    Editor: (props: EditorProps) => {
      capturedProps = props
      return <div data-testid="mock-editor">{props.title}</div>
    },
  }
})

const baseConfig = {
  schema: {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: {
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
      },
    ],
  },
  contentRoot: 'content',
  gitBotAuthorName: 'Bot',
  gitBotAuthorEmail: 'bot@example.com',
  editor: {
    title: 'Config Title',
    subtitle: 'Config Subtitle',
    theme: { colors: { brand: '#123456' } },
    previewBase: { 'content/posts': '/blog' },
  },
} as const

describe('CanopyEditor', () => {
  it('derives collections, preview bases, title/subtitle/theme from config', () => {
    capturedProps = undefined
    const { container } = renderComponent()
    const props = capturedProps as EditorProps | undefined

    expect(container.querySelector('[data-testid="mock-editor"]')?.textContent).toBe('Config Title')
    expect(props?.subtitle).toBe('Config Subtitle')
    expect(props?.collections?.[0]?.id).toBe('content/posts')
    expect(props?.previewBaseByCollection?.['content/posts']).toBe('/blog')
    expect(props?.themeOptions).toMatchObject({ colors: { brand: '#123456' } })
  })

  it('uses runtime branch overrides when provided', () => {
    capturedProps = undefined
    renderComponent({ branchName: 'feature' })

    const props = capturedProps as EditorProps | undefined
    expect(props?.branchName).toBe('feature')
  })
})

function renderComponent(extraProps: Partial<Omit<React.ComponentProps<typeof CanopyEditor>, 'config'>> = {}) {
  const { render } = require('@testing-library/react') as typeof import('@testing-library/react')
  const configWithFlat = {
    ...baseConfig,
    flatSchema: flattenSchema(baseConfig.schema, baseConfig.contentRoot),
  }
  return render(<CanopyEditor config={configWithFlat as any} entries={[]} {...extraProps} />)
}
