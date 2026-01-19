import React from 'react'

import { describe, expect, it, vi } from 'vitest'

import type { CanopyEditorProps } from './CanopyEditor'
import { CanopyEditorPage } from './CanopyEditorPage'

let capturedProps: CanopyEditorProps | undefined

vi.mock('./CanopyEditor', () => {
  return {
    __esModule: true,
    CanopyEditor: (props: CanopyEditorProps) => {
      capturedProps = props
      return <div data-testid="mock-canopy-editor">{props.branchName}</div>
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
  defaultBaseBranch: 'main',
} as const

describe('CanopyEditorPage', () => {
  it('passes search params through to CanopyEditor', () => {
    capturedProps = undefined
    const { render } = require('@testing-library/react') as typeof import('@testing-library/react')
    const Page = CanopyEditorPage(baseConfig as any)
    render(<Page searchParams={{ branch: 'feature', entry: 'id-1' }} />)

    const props = capturedProps as CanopyEditorProps | undefined
    expect(props?.branchName).toBe('feature')
    expect(props?.initialSelectedId).toBe('id-1')
  })

  it('falls back to config defaults when search params are missing', () => {
    capturedProps = undefined
    const { render } = require('@testing-library/react') as typeof import('@testing-library/react')
    const Page = CanopyEditorPage(baseConfig as any)
    render(<Page />)
    const props = capturedProps as CanopyEditorProps | undefined
    expect(props?.branchName).toBe('main')
  })
})
