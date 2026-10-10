import React from 'react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { flattenSchema } from '../config'
import type { CanopyClientConfig, EditorSignInProps } from '../config'
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
        entries: [
          {
            name: 'entry',
            format: 'json',
            schema: [{ name: 'title', type: 'string' }],
          },
        ],
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
    previewPrefix: '/preview',
  },
  mdxAllow: { htmlTags: [] },
} as const

// The editor mounts behind EditorAuthGate, which asks the API who the user is first.
let whoamiStatus = 200
beforeEach(() => {
  whoamiStatus = 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: whoamiStatus,
      ok: whoamiStatus < 400,
      json: async () =>
        whoamiStatus === 200
          ? { ok: true, status: 200, data: { userId: 'u1', groups: [] } }
          : { ok: false, status: whoamiStatus, error: 'Unauthorized' },
    })),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CanopyEditor', () => {
  it('derives collections, preview bases, title/subtitle/theme from config', async () => {
    capturedProps = undefined
    renderComponent()
    const editor = await screen.findByTestId('mock-editor')
    const props = capturedProps as EditorProps | undefined

    expect(editor.textContent).toBe('Config Title')
    expect(props?.subtitle).toBe('Config Subtitle')
    // First collection is now the content root, posts is a child
    expect(props?.collections?.[0]?.path).toBe('content')
    expect(props?.collections?.[0]?.children?.[0]?.path).toBe('content/posts')
    expect(props?.previewBaseByCollection).toEqual({ 'content/posts': '/blog' })
    expect(props?.previewPrefix).toBe('/preview')
    expect(props?.mdxAllow).toEqual({ htmlTags: [] })
    expect(props?.themeOptions).toMatchObject({ colors: { brand: '#123456' } })
  })

  it('uses runtime branch overrides when provided', async () => {
    capturedProps = undefined
    renderComponent({ branchName: 'feature' })
    await screen.findByTestId('mock-editor')

    const props = capturedProps as EditorProps | undefined
    expect(props?.branchName).toBe('feature')
  })

  it('threads customRenderers through to Editor unchanged', async () => {
    capturedProps = undefined
    const customRenderers: EditorProps['customRenderers'] = {
      number: () => <div data-testid="custom-number" />,
    }
    renderComponent({ customRenderers })
    await screen.findByTestId('mock-editor')

    const props = capturedProps as EditorProps | undefined
    expect(props?.customRenderers).toBe(customRenderers)
  })

  it('renders config.editor.SignInComponent in place of the editor when the API says 401', async () => {
    whoamiStatus = 401
    capturedProps = undefined
    const SignInComponent = ({ sessionRejected }: EditorSignInProps) => (
      <div data-testid="provider-sign-in">{String(sessionRejected)}</div>
    )
    renderComponent({}, { SignInComponent })

    expect((await screen.findByTestId('provider-sign-in')).textContent).toBe('false')
    expect(screen.queryByTestId('mock-editor')).toBeNull()
    expect(capturedProps).toBeUndefined()
  })
})

function renderComponent(
  extraProps: Partial<Omit<React.ComponentProps<typeof CanopyEditor>, 'config'>> = {},
  editorOverrides: NonNullable<CanopyClientConfig['editor']> = {},
) {
  const config = {
    ...baseConfig,
    editor: { ...baseConfig.editor, ...editorOverrides },
    flatSchema: flattenSchema(baseConfig.schema, baseConfig.contentRoot),
  } as unknown as CanopyClientConfig
  return render(<CanopyEditor config={config} entries={[]} {...extraProps} />)
}
