import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import matter from 'gray-matter'
import { format } from 'prettier'
import { afterEach, expect, it, vi } from 'vitest'

import { lexical, type EditorSubscription } from '@mdxeditor/editor'
import { serializeFrontmatter } from '../../utils/content-serialize'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MarkdownField } from './MarkdownField'
// Preloaded so the lazy editor chunk resolves from cache (see MarkdownField.test.tsx).
import '@mdxeditor/editor'
import './mdx-jsx-support'

vi.mock('../../api', async () => ({
  ...(await vi.importActual('../../api')),
  createApiClient: vi.fn(),
}))
// Stands in for the entry-link button, MDXEditor's insertMarkdown caller, inserting `insertion`.
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

afterEach(() => cleanup())

type LexicalEditor = Parameters<EditorSubscription>[0]

function lexicalEditorOf(root: HTMLElement): LexicalEditor {
  const editor: unknown = Reflect.get(root, '__lexicalEditor')
  if (typeof editor !== 'object' || editor === null) throw new Error('no lexical editor')
  return editor as LexicalEditor
}

/** Puts lexical's caret at `offset` in `text`; a click in jsdom leaves it at the start. */
function placeCaret(root: HTMLElement, text: Node, offset: number): void {
  root.focus()
  document.getSelection()?.collapse(text, offset)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

/** A Prettier-formatted file in the shapes MDXEditor re-serialises differently. */
const FILE = `---
title: Hello
---

## Heading

A paragraph with _emphasis_, **strong**, \`code\` and a [link](https://example.com).
A second line of the same paragraph. Escapes: a_b.

- First item
- Second item
  - Nested child
- Third item

1. One
2. Two

> A quote.

| Name  | Value |
| ----- | ----: |
| alpha |     1 |

---

Final paragraph.
`

/** The body the real rich editor sends after `edit`. */
async function editOnce(
  body: string,
  edit: (root: HTMLElement) => Promise<void>,
  emitted: string,
): Promise<string> {
  const Wrapper = createApiClientWrapper(await setupMockApiClient())
  const onChange = vi.fn()
  render(
    <CanopyCMSProvider>
      <Wrapper>
        <MarkdownField label="Body" value={body} onChange={onChange} />
      </Wrapper>
    </CanopyCMSProvider>,
  )
  const root = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.canopy-mdx-content[contenteditable="true"]')
    if (!el) throw new Error('rich editor not mounted')
    return el
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await edit(root)
  return waitFor(() => {
    const value: unknown = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]
    if (typeof value !== 'string' || !value.includes(emitted)) throw new Error('edit not emitted')
    return value
  })
}

const BODY = FILE.slice(FILE.indexOf('---\n', 4) + 4)

it('saves one keystroke in the rich editor as a one-line diff of a Prettier-clean file', async () => {
  const exported = await editOnce(BODY, (root) => userEvent.setup().type(root, 'Z'), 'Z')
  const saved = serializeFrontmatter(exported, { title: 'Hello' }, FILE, 'md')

  const before = FILE.split('\n')
  const after = saved.split('\n')
  expect(after).toHaveLength(before.length)
  const changed = after.filter((line, i) => line !== before[i])
  expect(changed).toHaveLength(1)
  expect(changed[0]).toContain('Z')
  expect(await format(saved, { parser: 'markdown' })).toBe(saved)
}, 30000)

it('writes an edited block in a Prettier-clean style', async () => {
  // MDXEditor inserts only at a selection, which typing establishes.
  insertion.markdown = 'an _inserted_ word '
  const exported = await editOnce(
    BODY,
    async (root) => {
      const user = userEvent.setup()
      await user.type(root, 'Z')
      await user.click(screen.getByTestId('insert-entry-link-button'))
    },
    'inserted',
  )
  const saved = serializeFrontmatter(exported, { title: 'Hello' }, FILE, 'md')

  const before = FILE.split('\n')
  const changed = saved.split('\n').filter((line, i) => line !== before[i])
  expect(changed).toEqual([expect.stringContaining('an _inserted_ word')])
  expect(await format(saved, { parser: 'markdown' })).toBe(saved)
}, 30000)

it('saves a one-line edit to a body that opens as source as a one-line diff', async () => {
  const file = fs.readFileSync(
    path.join(__dirname, '__fixtures__/markdown-corpus/list-item-paragraphs.md'),
    'utf8',
  )
  const { content, data } = matter(file, {})
  const Wrapper = createApiClientWrapper(await setupMockApiClient())
  const onChange = vi.fn()
  render(
    <CanopyCMSProvider>
      <Wrapper>
        <MarkdownField label="Body" value={content} onChange={onChange} />
      </Wrapper>
    </CanopyCMSProvider>,
  )
  await screen.findByTestId('markdown-source-fallback')
  const source = screen.getByTestId('markdown-source-editor')
  const line = 'Text after the nested list, still in the second item.'
  const end = content.indexOf(line) + line.length
  await userEvent
    .setup()
    .type(source, 'Z', { initialSelectionStart: end, initialSelectionEnd: end })

  const sent: unknown = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]
  if (typeof sent !== 'string') throw new Error('edit not emitted')
  const saved = serializeFrontmatter(sent, data, file, 'md')
  const before = file.split('\n')
  const after = saved.split('\n')
  expect(after).toHaveLength(before.length)
  expect(after.filter((text, i) => text !== before[i])).toEqual([`  ${line}Z`])
}, 30000)

const BARE_URLS_FILE = fs.readFileSync(
  path.join(__dirname, '__fixtures__/markdown-corpus/bare-urls.md'),
  'utf8',
)

it('saves a frontmatter-only edit with bare URLs in the body as the body on disk', async () => {
  const { content, data } = matter(BARE_URLS_FILE, {})
  const Wrapper = createApiClientWrapper(await setupMockApiClient())
  const onChange = vi.fn()
  render(
    <CanopyCMSProvider>
      <Wrapper>
        <MarkdownField label="Body" value={content} onChange={onChange} />
      </Wrapper>
    </CanopyCMSProvider>,
  )
  await waitFor(() => {
    if (!document.querySelector('.canopy-mdx-content[contenteditable="true"]')) {
      throw new Error('rich editor not mounted')
    }
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  const sent: unknown = onChange.mock.calls.at(-1)?.[0]
  const saved = serializeFrontmatter(
    typeof sent === 'string' ? sent : content,
    { ...data, description: 'A changed description.' },
    BARE_URLS_FILE,
    'md',
  )
  const bodyOf = (file: string) => file.slice(file.indexOf('\n---\n') + 5)
  expect(saved).toContain('A changed description.')
  expect(bodyOf(saved)).toBe(bodyOf(BARE_URLS_FILE))
  expect(onChange).not.toHaveBeenCalled()
}, 30000)

it('leaves the bare-URL paragraphs as they are when another paragraph is edited', async () => {
  const { content, data } = matter(BARE_URLS_FILE, {})
  const exported = await editOnce(
    content,
    async (root) => {
      const text = root.querySelector('p:last-of-type span')?.firstChild
      if (!text?.textContent) throw new Error('no last paragraph')
      placeCaret(root, text, text.textContent.length)
      await userEvent.setup().keyboard('Z')
    },
    'Z',
  )
  const saved = serializeFrontmatter(exported, data, BARE_URLS_FILE, 'md')

  const before = BARE_URLS_FILE.split('\n')
  const after = saved.split('\n')
  expect(after).toHaveLength(before.length)
  expect(after.filter((line, i) => line !== before[i])).toEqual(['A final paragraph.Z'])
}, 30000)

it('writes a URL typed in the editor as GFM reads it where it stands', async () => {
  const exported = await editOnce(
    'typed.\n',
    (root) =>
      userEvent
        .setup()
        .type(root, 'See www.example.org. Or https://example.org/x? Or www.ex_ample.org '),
    'See',
  )
  expect(exported).toBe(
    'See [www.example.org](http://www.example.org). Or [https://example.org/x](https://example.org/x)? Or www.ex_ample.org typed.',
  )
}, 30000)

it.each([
  ['www.example.org', 'www.example'.length, 'X', '[www.exampleX.org](http://www.exampleX.org)'],
  [
    'https://example.org/docs',
    'https://example.org/'.length,
    'v2/',
    '[https://example.org/v2/docs](https://example.org/v2/docs)',
  ],
  // No longer a URL to GFM: the link the editor shows.
  ['www.example.org', 'www.ex'.length, '_', '[www.ex_ample.org](http://www.example.org)'],
])(
  'saves an edited bare URL %s with the href its new text gives',
  async (url, at, keys, saved) => {
    const exported = await editOnce(
      `See ${url} today.\n`,
      async (root) => {
        const text = root.querySelector('a span')?.firstChild
        if (!text) throw new Error('no link')
        placeCaret(root, text, at)
        await userEvent.setup().keyboard(keys)
      },
      'today',
    )
    expect(exported).toBe(`See ${saved} today.`)
  },
  30000,
)

it('keeps the href of a bare URL whose link was changed in the editor', async () => {
  const exported = await editOnce(
    'See www.example.org today.\n',
    async (root) => {
      act(() => {
        lexicalEditorOf(root).update(() => {
          const paragraph = lexical.$getRoot().getFirstChild()
          const link = lexical.$isElementNode(paragraph) ? paragraph.getChildAtIndex(1) : null
          if (link === null || !('setURL' in link) || typeof link.setURL !== 'function') {
            throw new Error('no link')
          }
          link.setURL('https://example.net/')
        })
      })
      const text = root.querySelector('a span')?.firstChild
      if (!text) throw new Error('no link')
      placeCaret(root, text, 'www.example'.length)
      await userEvent.setup().keyboard('X')
    },
    'exampleX',
  )
  expect(exported).toBe('See [www.exampleX.org](https://example.net/) today.')
}, 30000)

it('keeps the format of the punctuation an auto-link leaves out', async () => {
  const exported = await editOnce(
    'typed.\n',
    (root) => {
      act(() => {
        lexicalEditorOf(root).update(() => {
          const paragraph = lexical.$getRoot().getFirstChild()
          if (!lexical.$isElementNode(paragraph)) throw new Error('no paragraph')
          const url = lexical.$createTextNode('www.example.org.').toggleFormat('bold')
          paragraph.splice(0, 0, [url, lexical.$createTextNode(' end ')])
        })
      })
      return Promise.resolve()
    },
    'end',
  )
  expect(exported).toBe('[**www.example.org**](http://www.example.org)**.** end typed.')
}, 30000)

it('saves text typed right after a bare URL outside it, as the editor shows', async () => {
  const exported = await editOnce(
    'See https://example.org today.\n',
    (root) => {
      act(() => {
        lexicalEditorOf(root).update(() => {
          const paragraph = lexical.$getRoot().getFirstChild()
          const link = lexical.$isElementNode(paragraph) ? paragraph.getChildAtIndex(1) : null
          const text = lexical.$isElementNode(link) ? link.getFirstChild() : null
          if (!lexical.$isTextNode(text)) throw new Error('no link')
          // Lexical's own insert path, which a browser's input takes: past a link, it lands after.
          text.select(text.getTextContentSize(), text.getTextContentSize())
          const selection = lexical.$getSelection()
          if (!lexical.$isRangeSelection(selection)) throw new Error('no selection')
          selection.insertText('/docs')
        })
      })
      return Promise.resolve()
    },
    '/docs',
  )
  expect(exported).toBe('See [https://example.org](https://example.org)/docs today.')
}, 30000)

it('keeps a bare URL given a label as the link the editor shows', async () => {
  const exported = await editOnce(
    'See https://example.org today.\n',
    (root) => {
      act(() => {
        lexicalEditorOf(root).update(() => {
          const paragraph = lexical.$getRoot().getFirstChild()
          const link = lexical.$isElementNode(paragraph) ? paragraph.getChildAtIndex(1) : null
          const text = lexical.$isElementNode(link) ? link.getFirstChild() : null
          if (!lexical.$isTextNode(text)) throw new Error('no link')
          text.setTextContent('Example site')
        })
      })
      return Promise.resolve()
    },
    'Example site',
  )
  expect(exported).toBe('See [Example site](https://example.org) today.')
}, 30000)

it('keeps the href of a link written as `[url](url)` when its text is edited', async () => {
  const exported = await editOnce(
    'See [https://example.org/docs](https://example.org/docs) today.\n',
    async (root) => {
      const text = root.querySelector('a span')?.firstChild
      if (!text) throw new Error('no link')
      placeCaret(root, text, 'https://example.org/'.length)
      await userEvent.setup().keyboard('v2/')
    },
    'v2/',
  )
  expect(exported).toBe('See [https://example.org/v2/docs](https://example.org/docs) today.')
}, 30000)
