import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MarkdownField } from './MarkdownField'

// Preload the chunks MarkdownField's React.lazy() imports.
//
// The mount assertion below is about WHETHER the real editor mounts, not how
// fast: without this it also silently measures how long vitest takes to
// transform @mdxeditor/editor, because the lazy promise only settles once
// that work is done. That made the test fail under full-suite contention
// while passing whenever this project ran alone -- a real defect in the test,
// not flakiness to paper over with a longer timeout.
//
// Importing the same specifier statically puts the module in vitest's
// registry during THIS file's import phase, so React.lazy's import()
// resolves from cache on the first microtask and the assertion measures only
// the product. Same specifier as MarkdownField.tsx uses, deliberately -- a
// different one would warm nothing.
import '@mdxeditor/editor'
import './mdx-jsx-support'

vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// The entry-link button is MarkdownField's one caller of MDXEditor's
// insertMarkdown; this stand-in inserts whatever a test puts in `insertion`.
const insertion = { markdown: '' }
vi.mock('./entry-link', () => ({
  InsertEntryLink: ({ onInsert }: { onInsert: (markdown: string) => void }) => (
    <button
      type="button"
      data-testid="insert-entry-link-button"
      onClick={() => onInsert(insertion.markdown)}
    >
      link
    </button>
  ),
}))

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

describe('MarkdownField', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the fallback textarea while the MDXEditor chunk loads', () => {
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <MarkdownField value="hello" onChange={() => {}} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    // Synchronous first render, before Suspense resolves the lazy import -
    // the readonly fallback textarea is what's on screen.
    expect(screen.getByPlaceholderText('Loading markdown editor...')).toBeTruthy()
  })

  /**
   * Full end-to-end coverage of the MDX image dialog (clicking the toolbar's
   * icon-only "Insert Image" button, which mdxeditor renders via a Radix
   * Tooltip trigger with no static accessible name/role testing-library can
   * target) is impractical here - see the PR report. This test instead
   * confirms the integration point that IS reliably observable: once the
   * real MDXEditor mounts, our custom `MdxImageDialog` (not the stock one)
   * is wired in as a composer child via `imagePlugin({ ImageDialog })`.
   * MdxImageDialog's own tabs/save/cancel behavior is unit-tested directly
   * (with plain props) in MdxImageDialog.test.tsx.
   */
  it('mounts the real MDXEditor with our custom image dialog wired in', async () => {
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <MarkdownField value="hello" onChange={() => {}} />
        </Wrapper>
      </CanopyCMSProvider>,
    )

    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toBeTruthy())
    expect(screen.getByTestId('mdx-image-dialog')).toBeTruthy()
    // The custom InsertEntryLink toolbar button is on the same toolbar,
    // confirming the toolbar itself rendered (not just an editor shell).
    expect(screen.getByTestId('insert-entry-link-button')).toBeTruthy()
  })

  function renderField(value: string, onChange: (value: string) => void = () => {}) {
    const Wrapper = wrapper
    return render(
      <CanopyCMSProvider>
        <Wrapper>
          <MarkdownField label="Body" value={value} onChange={onChange} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
  }

  /** The root editor, once MDXEditor has mounted and imported the document. */
  async function richEditor(): Promise<HTMLElement> {
    const root = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.canopy-mdx-content[contenteditable="true"]')
      if (!el) throw new Error('rich editor not mounted')
      return el
    })
    // Let the import's update commit and any nested JSX editors mount.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    return root
  }

  const lastValue = (onChange: ReturnType<typeof vi.fn>): string => {
    const calls = onChange.mock.calls
    const value: unknown = calls[calls.length - 1]?.[0]
    if (typeof value !== 'string') throw new Error('onChange was never called with a string')
    return value
  }

  describe('body images', () => {
    const OLD_SRC = `/assets/t/orig/${'a'.repeat(32)}/photo.png`
    const NEW_SRC = `/assets/t/orig/${'b'.repeat(32)}/other.png`
    const RAW_ROUTE = '/api/canopycms/assets/raw'

    // jsdom never loads an image, and MDXEditor renders an image node only once its preload
    // `Image` fires onload/onerror. This stub fires onload on the first `src` set.
    const realImage = globalThis.Image
    beforeAll(() => {
      class LoadedImage {
        onload: null | (() => void) = null
        onerror: null | (() => void) = null
        set src(_value: string) {
          setTimeout(() => this.onload?.(), 0)
        }
      }
      globalThis.Image = LoadedImage as unknown as typeof Image
    })
    afterAll(() => {
      globalThis.Image = realImage
    })

    const urlInput = () => screen.getByTestId<HTMLInputElement>('mdx-image-dialog-url')

    /** Opens the edit dialog for the body's one image and waits for its URL field. */
    async function openEditDialog(): Promise<HTMLInputElement> {
      fireEvent.click(await screen.findByTitle('Edit image'))
      await screen.findByTestId('mdx-image-dialog-url')
      await waitFor(() => expect(urlInput().value).not.toBe(''))
      return urlInput()
    }

    it('are displayed through the authenticated asset route', async () => {
      renderField(`![alt](${OLD_SRC})`)
      await richEditor()

      const img = await screen.findByAltText('alt')
      expect(img.getAttribute('src')).toBe(`${RAW_ROUTE}${OLD_SRC}`)
    })

    it('keep a changed src through a second edit, stored root-relative', async () => {
      const onChange = vi.fn()
      renderField(`![alt](${OLD_SRC})`, onChange)
      await richEditor()
      await screen.findByAltText('alt')

      expect((await openEditDialog()).value).toBe(OLD_SRC)
      fireEvent.change(urlInput(), { target: { value: NEW_SRC } })
      fireEvent.click(screen.getByTestId('mdx-image-dialog-url-submit'))
      await waitFor(() => expect(lastValue(onChange)).toContain(NEW_SRC))

      // The second dialog must show the src the node now has, not the one it was rendered with.
      expect((await openEditDialog()).value).toBe(NEW_SRC)
      const calls = onChange.mock.calls.length
      fireEvent.change(screen.getByTestId('mdx-image-dialog-alt'), { target: { value: 'fixed' } })
      fireEvent.click(screen.getByTestId('mdx-image-dialog-url-submit'))
      await waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(calls))

      await waitFor(() => expect(lastValue(onChange)).toBe(`![fixed](${NEW_SRC})`))
      for (const [value] of onChange.mock.calls) {
        expect(value).not.toContain(RAW_ROUTE)
      }
    })
  })

  const JSX_BODY = [
    'Intro paragraph.',
    '',
    '<Callout type="info" title="Note">',
    'Callout text.',
    '</Callout>',
    '',
    'Inline <Badge color="red">new</Badge> and <Icon name="star" />.',
  ].join('\n')

  describe('JSX elements no descriptor names', () => {
    it('emits edits to the surrounding markdown and keeps the elements intact', async () => {
      const onChange = vi.fn()
      renderField(JSX_BODY, onChange)
      const root = await richEditor()
      const user = userEvent.setup()

      await user.click(root.querySelector('p') ?? root)
      await user.keyboard('typed')

      await waitFor(() => expect(onChange).toHaveBeenCalled())
      const value = lastValue(onChange)
      expect(value).toContain('typed')
      expect(value).toContain('<Callout type="info" title="Note">')
      expect(value).toContain('Callout text.')
      expect(value).toContain('<Badge color="red">new</Badge>')
      expect(value).toContain('<Icon name="star" />')
      expect(screen.queryByTestId('markdown-source-fallback')).toBeNull()
    })

    it('emits edits made inside a block element once focus leaves it', async () => {
      // MDXEditor copies a nested editor's content into the document on blur.
      const onChange = vi.fn()
      renderField(JSX_BODY, onChange)
      const root = await richEditor()
      const user = userEvent.setup()
      const nested = await waitFor(() => {
        const el = document.querySelector<HTMLElement>(
          'div.canopy-mdx-jsx [contenteditable="true"]',
        )
        if (!el) throw new Error('nested editor not mounted')
        return el
      })

      await user.click(nested.querySelector('p') ?? nested)
      await user.keyboard('inside')
      await user.click(root.querySelector('p') ?? root)

      await waitFor(() =>
        expect(lastValue(onChange)).toMatch(/<Callout[^>]*>[^<]*inside[^<]*<\/Callout>/),
      )
    })

    it('shows each element tag and attributes, with its children editable', async () => {
      renderField(JSX_BODY)
      await richEditor()
      const elements = Array.from(document.querySelectorAll('.canopy-mdx-jsx')).map((el) => ({
        tag: el.querySelector('[data-testid="mdx-jsx-tag"]')?.textContent,
        inline: el.classList.contains('canopy-mdx-jsx-inline'),
        children: el.querySelector('[contenteditable="true"]')?.textContent ?? null,
      }))
      expect(elements).toEqual([
        { tag: '<Callout type="info" title="Note">', inline: false, children: 'Callout text.' },
        { tag: '<Badge color="red">', inline: true, children: 'new' },
        { tag: '<Icon name="star">', inline: true, children: null },
      ])
    })
  })

  it.each([
    ['string attributes', 'A <span className="b"><span className="c">x</span></span> B'],
    [
      'an expression attribute',
      'A <a href={url}>x</a> and <span style={{ color: "red" }}>y</span>',
    ],
    [
      'an image it writes back unchanged',
      'A <img src="a.png" alt="A" width="40" loading="lazy" /> x',
    ],
  ])('keeps HTML elements with %s in the rich editor', async (_case, body) => {
    renderField(body)
    const root = await richEditor()
    expect(root.textContent).toContain('x')
    expect(screen.queryByTestId('markdown-source-fallback')).toBeNull()
  })

  // MDXEditor re-serializes both: `__x__` as `**x**`, and a block element's
  // children indented.
  it.each([
    ['markdown it rewrites', 'Some __bold__ text.'],
    ['a JSX element', JSX_BODY],
  ])('does not report the re-serialization of unedited %s as a change', async (_case, body) => {
    const onChange = vi.fn()
    renderField(body, onChange)
    await richEditor()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('emits the first edit to a document the import did not reformat', async () => {
    const onChange = vi.fn()
    renderField('Plain text.', onChange)
    const root = await richEditor()
    const user = userEvent.setup()

    await user.click(root.querySelector('p') ?? root)
    await user.keyboard('X')

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(lastValue(onChange)).toContain('X')
  })

  describe('source editor fallback', () => {
    it.each([
      ['an unclosed tag', 'Line one<br>line two'],
      ['an unbalanced expression', 'Costs { 5 dollars.'],
      [
        'content inside an element that the rich editor cannot import',
        '<Callout>\nSee [the docs][docs].\n\n[docs]: https://example.com\n</Callout>',
      ],
      ['an import statement', "import { Chart } from './chart'\n\n<Chart />"],
      ['a block fragment', '<>\nFragment text.\n</>'],
      ['an inline fragment', 'Text <>inside</> a fragment.'],
      ['a fragment inside an element', '<Callout>\nA <>b</> c.\n</Callout>'],
      ['a fragment inside a table cell', '| a | b |\n| --- | --- |\n| x <>y</> z | w |'],
      [
        'an element wrapping a span, with an expression class',
        'A <span className={cls}><span className="b">x</span></span> B',
      ],
      [
        'an element wrapping a span with an expression style',
        'A <span style="color: red"><span style={s}>x</span></span> B',
      ],
      [
        'such an element inside a JSX element',
        '<Callout>\nA <span className={cls}><span className="b">x</span></span> B\n</Callout>',
      ],
      ['an image with an expression src', 'Pic <img src={hero} alt="Hero" /> end'],
      ['an image without a src', 'Pic <img alt="No src" /> end'],
      [
        'an image with a camelCase attribute',
        'Pic <img src="a.png" alt="A" className="hero" /> end',
      ],
      ['an image with a boolean attribute', 'Pic <img src="a.png" alt="A" hidden /> end'],
      ['an image with a percentage width', 'Pic <img src="a.png" alt="A" width="50%" /> end'],
    ])('opens a body with %s as editable source', async (_case, body) => {
      const onChange = vi.fn()
      renderField(body, onChange)

      expect(await screen.findByTestId('markdown-source-fallback')).toBeTruthy()
      const source = screen.getByTestId('markdown-source-editor')
      if (!(source instanceof HTMLTextAreaElement))
        throw new Error('source editor is not a textarea')
      expect(source.value).toBe(body)
      expect(onChange).not.toHaveBeenCalled()

      const user = userEvent.setup()
      await user.click(source)
      await user.keyboard('{Control>}{End}{/Control}!')
      expect(lastValue(onChange)).toBe(`${body}!`)
    })
  })

  /** Renders the field with its value held by the test, as the form holds it. */
  function renderControlled(initial: string) {
    const onChange = vi.fn()
    const external: { set: (value: string) => void } = { set: () => {} }
    const Controlled: React.FC = () => {
      const [value, setValue] = React.useState(initial)
      React.useEffect(() => {
        external.set = setValue
      }, [])
      return (
        <MarkdownField
          label="Body"
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
        />
      )
    }
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <Controlled />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    return {
      onChange,
      setExternal: (value: string) =>
        act(async () => {
          external.set(value)
        }),
    }
  }

  it('edits the current value after it changed while source was showing', async () => {
    // The field is not remounted between entries: entry A, source, entry B,
    // rich text, back to entry A.
    const { onChange, setExternal } = renderControlled('Entry A.')
    await richEditor()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('markdown-mode-toggle'))
    await setExternal('Entry B.')
    await user.click(screen.getByTestId('markdown-mode-toggle'))
    await richEditor()
    await setExternal('Entry A.')

    const root = await richEditor()
    await waitFor(() => expect(root.textContent).toBe('Entry A.'))
    await user.click(root.querySelector('p') ?? root)
    await user.keyboard('X')
    await waitFor(() => expect(lastValue(onChange)).toContain('Entry A.'))
    expect(lastValue(onChange)).not.toContain('Entry B.')
  })

  it('stays in the fallback while its source is edited', async () => {
    const { onChange } = renderControlled('Line one<br>line two')
    const source = await screen.findByTestId('markdown-source-editor')
    const user = userEvent.setup()

    await user.type(source, ' more')

    expect(lastValue(onChange)).toBe('Line one<br>line two more')
    expect(screen.getByTestId('markdown-source-fallback')).toBeTruthy()
    expect(screen.getByTestId('markdown-source-editor')).toBe(source)
  })

  it('falls back when the next value is also one MDXEditor rejects', async () => {
    const { setExternal } = renderControlled('Line one<br>line two')
    expect(await screen.findByTestId('markdown-source-fallback')).toBeTruthy()

    await setExternal('import { Chart } from "./chart"\n\n<Chart />')

    await waitFor(() => {
      const source = screen.getByTestId('markdown-source-editor')
      if (!(source instanceof HTMLTextAreaElement)) throw new Error('not a textarea')
      expect(source.value).toBe('import { Chart } from "./chart"\n\n<Chart />')
    })
    expect(screen.getByTestId('markdown-source-fallback')).toBeTruthy()
  })

  it('falls back again when an edited fallback is reset to the rejected value', async () => {
    const { setExternal } = renderControlled('Line one<br>line two')
    const source = await screen.findByTestId('markdown-source-editor')
    await userEvent.setup().type(source, ' more')

    await setExternal('Line one<br>line two')

    await waitFor(() => expect(screen.getByTestId('markdown-source-fallback')).toBeTruthy())
    expect(screen.getByTestId<HTMLTextAreaElement>('markdown-source-editor').value).toBe(
      'Line one<br>line two',
    )
  })

  describe('inserted markdown', () => {
    async function insertInto(body: string, markdown: string) {
      insertion.markdown = markdown
      const onChange = vi.fn()
      renderField(body, onChange)
      const root = await richEditor()
      const user = userEvent.setup()
      await user.click(root.querySelector('p') ?? root)
      await user.click(screen.getByTestId('insert-entry-link-button'))
      return onChange
    }

    it('is added to the document', async () => {
      const onChange = await insertInto('Body text.', '[Home](entry:abc123)')
      await waitFor(() => expect(lastValue(onChange)).toContain('[Home](entry:abc123)'))
      expect(lastValue(onChange)).toContain('Body text.')
    })

    it('that MDXEditor rejects leaves the body intact and opens it as source', async () => {
      const onChange = await insertInto('Body text.', '[Use <br> tags](entry:abc123)')

      expect(await screen.findByTestId('markdown-source-fallback')).toBeTruthy()
      expect(screen.getByTestId<HTMLTextAreaElement>('markdown-source-editor').value).toBe(
        'Body text.',
      )
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  it('tries rich text again when the value changes after a fallback', async () => {
    const { setExternal } = renderControlled('Line one<br>line two')
    expect(await screen.findByTestId('markdown-source-fallback')).toBeTruthy()

    await setExternal('A parseable body.')

    const root = await richEditor()
    expect(root.textContent).toBe('A parseable body.')
    expect(screen.queryByTestId('markdown-source-fallback')).toBeNull()
  })

  it('switches between rich text and source on request', async () => {
    const onChange = vi.fn()
    const Stateful: React.FC = () => {
      const [value, setValue] = React.useState('Hello')
      return (
        <MarkdownField
          label="Body"
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
        />
      )
    }
    const Wrapper = wrapper
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <Stateful />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    await richEditor()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('markdown-mode-toggle'))
    const source = screen.getByTestId('markdown-source-editor')
    expect(screen.queryByTestId('markdown-source-fallback')).toBeNull()
    await user.type(source, ' <Callout>there</Callout>')
    expect(lastValue(onChange)).toBe('Hello <Callout>there</Callout>')

    await user.click(screen.getByTestId('markdown-mode-toggle'))
    await richEditor()
    expect(screen.queryByTestId('markdown-source-editor')).toBeNull()
    expect(screen.getByTestId('mdx-jsx-tag').textContent).toBe('<Callout>')
  })
})
