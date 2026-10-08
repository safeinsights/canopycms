import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MarkdownField } from './MarkdownField'
import { resetRichTextFailures } from './rich-text-failures'
import { mockConsole, type MockConsole } from '../../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../../test-utils/render-errors'
// Preloads MarkdownField's lazy chunk, as MarkdownField.test.tsx explains.
import '@mdxeditor/editor'

vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return { ...actual, createApiClient: vi.fn() }
})

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

// The render-phase crash a duplicated MDXEditor module produced in an adopter's build.
const mdxEditorRenders = vi.fn()
vi.mock('@mdxeditor/editor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mdxeditor/editor')>()),
  MDXEditor: () => {
    mdxEditorRenders()
    throw new Error('useNestedEditor must be used within a NestedEditorsProvider')
  },
}))

describe('MarkdownField when the rich-text editor throws while rendering', () => {
  let mockClient: MockApiClient
  let consoleSpy: MockConsole
  let unsilence: () => void

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    consoleSpy = mockConsole()
    unsilence = silenceReportedRenderErrors()
    mdxEditorRenders.mockClear()
    resetRichTextFailures()
  })

  afterEach(() => {
    unsilence()
    consoleSpy.restore()
  })

  function renderField(value: string) {
    const onChange = vi.fn()
    const Wrapper = createApiClientWrapper(mockClient)
    const Controlled: React.FC = () => {
      const [current, setCurrent] = React.useState(value)
      return (
        <MarkdownField
          label="Body"
          value={current}
          dataCanopyField="body"
          onChange={(next) => {
            onChange(next)
            setCurrent(next)
          }}
        />
      )
    }
    const view = render(
      <CanopyCMSProvider>
        <Wrapper>
          <Controlled />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    return { onChange, unmount: view.unmount }
  }

  it('opens the body as source with a notice, and edits flow to onChange', async () => {
    const { onChange } = renderField('# Title\n\n<Callout>Hi</Callout>')

    const notice = await screen.findByTestId('markdown-source-fallback')
    expect(notice.textContent).toContain(
      "This content couldn't be opened in the visual editor. You can still edit the text and save.",
    )
    expect(notice.textContent).toContain('useNestedEditor must be used within')
    expect(consoleSpy).toHaveErrored('[canopycms] editor error caught (rich-text body)')

    const source = screen.getByTestId<HTMLTextAreaElement>('markdown-source-editor')
    expect(source.value).toBe('# Title\n\n<Callout>Hi</Callout>')
    mdxEditorRenders.mockClear()
    await userEvent.setup().type(source, '!')
    expect(onChange).toHaveBeenLastCalledWith('# Title\n\n<Callout>Hi</Callout>!')
    // The edited text stays in source; the rich-text editor is not tried on it.
    expect(screen.getByTestId('markdown-source-editor')).toBe(source)
    expect(mdxEditorRenders).not.toHaveBeenCalled()
  })

  it('opens the same body straight to source when it is shown again', async () => {
    const first = renderField('Body text.')
    await screen.findByTestId('markdown-source-fallback')
    first.unmount()
    mdxEditorRenders.mockClear()

    renderField('Body text.')

    expect(screen.getByTestId('markdown-source-fallback')).toBeTruthy()
    expect(mdxEditorRenders).not.toHaveBeenCalled()
  })

  it("keeps every field in source while one field's source is edited at length", async () => {
    const Wrapper = createApiClientWrapper(mockClient)
    const Two: React.FC = () => {
      const [a, setA] = React.useState('First body.')
      return (
        <CanopyCMSProvider>
          <Wrapper>
            <MarkdownField label="A" value={a} onChange={setA} />
            <MarkdownField label="B" value="Second body." onChange={() => {}} />
          </Wrapper>
        </CanopyCMSProvider>
      )
    }
    render(<Two />)
    await waitFor(() => expect(screen.getAllByTestId('markdown-source-fallback')).toHaveLength(2))
    mdxEditorRenders.mockClear()

    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: 'A (source)' }), ' and twenty-five more chars')

    expect(mdxEditorRenders).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('markdown-source-fallback')).toHaveLength(2)
  })

  it('tries the rich-text editor again when asked', async () => {
    renderField('Body text.')
    await screen.findByTestId('markdown-source-fallback')
    mdxEditorRenders.mockClear()

    await userEvent.setup().click(screen.getByTestId('markdown-mode-toggle'))

    await waitFor(() => expect(mdxEditorRenders).toHaveBeenCalled())
    expect(await screen.findByTestId('markdown-source-fallback')).toBeTruthy()
  })
})
