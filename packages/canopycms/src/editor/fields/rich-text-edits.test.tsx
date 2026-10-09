/**
 * Edits in the rich-text editor that reshape quotes, and what each saves. The editor is the
 * Lexical instance on MarkdownField's root contenteditable, driven through MDXEditor's own
 * `lexical` export so commands and node checks match its instance. jsdom has no
 * `Selection.modify`, so Backspace is `DELETE_CHARACTER_COMMAND` at a caret set in an update.
 */
import React, { Suspense } from 'react'
import { act, render } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'

import * as mdx from '@mdxeditor/editor'
import type { MDXEditorMethods } from '@mdxeditor/editor'
import { getErrorMessage } from '../../utils/error'
import { markdownBlocks } from '../../utils/markdown-body-splice'
import { createApiClientWrapper, setupMockApiClient } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MDXEditorLazy } from './MarkdownField'

vi.mock('../../api', async () => ({
  ...(await vi.importActual('../../api')),
  createApiClient: vi.fn(),
}))
vi.mock('./entry-link', () => ({ InsertEntryLink: () => null }))
vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

let ApiClient: React.FC<{ children: React.ReactNode }>
beforeAll(async () => {
  ApiClient = createApiClientWrapper(await setupMockApiClient())
})

type Lexical = typeof mdx.lexical
type Editor = ReturnType<Lexical['createEditor']>
type TextNode = ReturnType<Lexical['$createTextNode']>
type LexicalNode = NonNullable<Parameters<Lexical['$isTextNode']>[0]>
type Edit = (editor: Editor, lx: Lexical) => void

async function editAndExport(body: string, edit: Edit): Promise<string> {
  const editorRef = React.createRef<MDXEditorMethods>()
  let reported: string | undefined
  const view = render(
    <CanopyCMSProvider>
      <ApiClient>
        <Suspense fallback={null}>
          <MDXEditorLazy
            markdown={body}
            onChange={() => {}}
            onError={({ error }) => {
              reported ??= error
            }}
            onInsert={(insert) => insert()}
            editorRef={editorRef}
            imageUploadHandler={() => Promise.reject(new Error('no uploads in this test'))}
            imagePreviewHandler={(src) => Promise.resolve(src)}
          />
        </Suspense>
      </ApiClient>
    </CanopyCMSProvider>,
  )
  try {
    await act(async () => {})
    if (reported !== undefined) throw new Error(`opens as source: ${reported}`)
    const root: (Element & { __lexicalEditor?: Editor }) | null =
      view.container.querySelector('.canopy-mdx-content')
    const editor = root?.__lexicalEditor
    if (!editor) throw new Error('no Lexical editor on the root contenteditable')
    await act(async () => {
      edit(editor, mdx.lexical)
    })
    const exported = editorRef.current?.getMarkdown()
    if (exported === undefined) throw new Error('the editor did not mount')
    return exported
  } catch (err: unknown) {
    throw new Error(getErrorMessage(err))
  } finally {
    view.unmount()
  }
}

/** The first text node whose content is `text`. Call inside an update. */
function textNode(lx: Lexical, text: string): TextNode {
  const queue: LexicalNode[] = [lx.$getRoot()]
  while (queue.length > 0) {
    const node = queue.shift()
    if (lx.$isTextNode(node) && node.getTextContent() === text) return node
    if (lx.$isElementNode(node)) queue.push(...node.getChildren())
  }
  throw new Error(`no text node "${text}"`)
}

const caretAt = (editor: Editor, lx: Lexical, text: string, end = false) =>
  editor.update(
    () => {
      const node = textNode(lx, text)
      const offset = end ? node.getTextContentSize() : 0
      node.select(offset, offset)
    },
    { discrete: true },
  )

const insertText = (editor: Editor, lx: Lexical, text: string) =>
  editor.update(
    () => {
      const selection = lx.$getSelection()
      if (lx.$isRangeSelection(selection)) selection.insertText(text)
    },
    { discrete: true },
  )

/** Types `text` at the start of text node `at`, a character per update as keystrokes arrive. */
const typeAtStartOf =
  (at: string, text: string): Edit =>
  (editor, lx) => {
    caretAt(editor, lx, at)
    for (const character of text) insertText(editor, lx, character)
  }

const backspaceAtStartOf =
  (at: string): Edit =>
  (editor, lx) => {
    caretAt(editor, lx, at)
    editor.dispatchCommand(lx.DELETE_CHARACTER_COMMAND, true)
  }

/** Enter at the end of `at`, types `typed`, then Backspace at the start of `at`. */
const enterTypeThenBackspace =
  (at: string, typed: string): Edit =>
  (editor, lx) => {
    caretAt(editor, lx, at, true)
    editor.dispatchCommand(lx.INSERT_PARAGRAPH_COMMAND, undefined)
    insertText(editor, lx, typed)
    caretAt(editor, lx, at)
    editor.dispatchCommand(lx.DELETE_CHARACTER_COMMAND, true)
  }

const meanings = (text: string) =>
  markdownBlocks(text, 'md')?.map((block) =>
    JSON.stringify(
      JSON.parse(block.meaning, (key, value: unknown) => (key === 'spread' ? undefined : value)),
    ),
  )

const EDITS: { name: string; body: string; edit: Edit; saved: string }[] = [
  {
    name: 'the `> ` shortcut quotes a paragraph with bold as one paragraph',
    body: 'a **b** c\n',
    edit: typeAtStartOf('a ', '> '),
    saved: '> a **b** c\n',
  },
  {
    name: 'the `> ` shortcut quotes a paragraph with a link as one paragraph',
    body: 'see [docs](/d) now\n',
    edit: typeAtStartOf('see ', '> '),
    saved: '> see [docs](/d) now\n',
  },
  {
    name: 'the `> ` shortcut quotes a plain paragraph',
    body: 'a\nb\n',
    edit: typeAtStartOf('a\nb', '> '),
    saved: '> a\n> b\n',
  },
  {
    name: 'Backspace at the start of a two-paragraph quote keeps both paragraphs',
    body: '> a\n>\n> b\n',
    edit: backspaceAtStartOf('a'),
    saved: 'a\n\nb\n',
  },
  {
    name: 'Backspace at the start of a quote with a list keeps the list',
    body: '> a\n>\n> - b\n',
    edit: backspaceAtStartOf('a'),
    saved: 'a\n\n- b\n',
  },
  {
    name: 'Backspace at the start of a one-paragraph quote unquotes it',
    body: '> a **b** c\n',
    edit: backspaceAtStartOf('a '),
    saved: 'a **b** c\n',
  },
  {
    name: 'Enter in a quote, then Backspace at its start, keeps both paragraphs',
    body: '> a\n',
    edit: enterTypeThenBackspace('a', 'new'),
    saved: 'a\n\nnew\n',
  },
]

for (const { name, body, edit, saved } of EDITS) {
  it(
    name,
    async () => {
      expect(meanings(await editAndExport(body, edit))).toEqual(meanings(saved))
    },
    30_000,
  )
}
