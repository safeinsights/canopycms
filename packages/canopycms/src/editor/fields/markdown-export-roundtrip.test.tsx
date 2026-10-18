import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import matter from 'gray-matter'
import { format } from 'prettier'
import { afterEach, expect, it, vi } from 'vitest'

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
      // Lexical follows the DOM selection; a click in jsdom leaves the caret at the start.
      const text = root.querySelector('p:last-of-type span')?.firstChild
      if (!text?.textContent) throw new Error('no last paragraph')
      root.focus()
      document.getSelection()?.collapse(text, text.textContent.length)
      act(() => {
        document.dispatchEvent(new Event('selectionchange'))
      })
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
