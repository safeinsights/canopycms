/**
 * What the rich-text toolbar can write in a field whose MDX allowlist narrows its HTML tags: the
 * editor offers, and saves, no tag the server would refuse.
 */
import React, { Suspense } from 'react'
import { act, render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import * as mdx from '@mdxeditor/editor'
import type { MDXEditorMethods } from '@mdxeditor/editor'
import type { EntrySchema, MdxAllowlist } from '../../config'
import { findUnsafeMarkdown } from '../../validation/markdown-safety'
import { resolveMdxAllowlist } from '../../validation/mdx-allowlist'
import { SiteMdxAllowContext } from '../context'
import { FormRenderer } from '../FormRenderer'
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
type TextFormat = Parameters<ReturnType<Lexical['$createTextNode']>['hasFormat']>[0]

const narrow: MdxAllowlist = { components: { Callout: {} }, htmlTags: [], expressions: false }

/** Applies `format` to the word `word` in `body`, as the toolbar or a shortcut does, and exports. */
async function formatAndExport(
  body: string,
  word: string,
  format: TextFormat,
  htmlTags?: ReadonlySet<string>,
): Promise<string> {
  const editorRef = React.createRef<MDXEditorMethods>()
  const view = render(
    <CanopyCMSProvider>
      <ApiClient>
        <Suspense fallback={null}>
          <MDXEditorLazy
            markdown={body}
            onChange={() => {}}
            onError={({ error }) => {
              throw new Error(error)
            }}
            onInsert={(insert) => insert()}
            editorRef={editorRef}
            imageUploadHandler={() => Promise.reject(new Error('no uploads in this test'))}
            imagePreviewHandler={(src) => Promise.resolve(src)}
            htmlTags={htmlTags}
          />
        </Suspense>
      </ApiClient>
    </CanopyCMSProvider>,
  )
  try {
    await act(async () => {})
    const root: (Element & { __lexicalEditor?: Editor }) | null =
      view.container.querySelector('.canopy-mdx-content')
    const editor = root?.__lexicalEditor
    if (!editor) throw new Error('no Lexical editor on the root contenteditable')
    const lx = mdx.lexical
    await act(async () => {
      editor.update(
        () => {
          const paragraph = lx.$getRoot().getFirstChild()
          const text = lx.$isElementNode(paragraph) ? paragraph.getFirstChild() : null
          if (!lx.$isTextNode(text)) throw new Error('no text node')
          const start = text.getTextContent().indexOf(word)
          text.select(start, start + word.length)
        },
        { discrete: true },
      )
      editor.dispatchCommand(lx.FORMAT_TEXT_COMMAND, format)
    })
    const exported = editorRef.current?.getMarkdown()
    if (exported === undefined) throw new Error('the editor did not mount')
    return exported
  } finally {
    view.unmount()
  }
}

describe('a field whose allowlist leaves out a formatting tag', () => {
  it.each([
    ['underline', 'u'],
    ['superscript', 'sup'],
    ['subscript', 'sub'],
  ] as const)('saves %s applied by command as plain text', async (format, tag) => {
    const body = 'Some important words.\n'
    expect(await formatAndExport(body, 'important', format)).toContain(`<${tag}>important</${tag}>`)

    const exported = await formatAndExport(body, 'important', format, new Set())
    expect(exported.trim()).toBe(body.trim())
    expect(findUnsafeMarkdown(exported, 'mdx', resolveMdxAllowlist(narrow, undefined))).toEqual([])
  })

  it('keeps a formatting tag the allowlist names', async () => {
    const exported = await formatAndExport('Some words.\n', 'words', 'underline', new Set(['u']))
    expect(exported).toContain('<u>words</u>')
  })

  it('keeps the formats that are not tags', async () => {
    const exported = await formatAndExport('Some words.\n', 'words', 'bold', new Set())
    expect(exported).toContain('**words**')
  })
})

describe('the toolbar through FormRenderer', () => {
  const underlineButtons = async (fields: EntrySchema, site?: MdxAllowlist) => {
    const view = render(
      <CanopyCMSProvider>
        <ApiClient>
          <SiteMdxAllowContext.Provider value={site}>
            <FormRenderer fields={fields} value={{ body: 'Text' }} onChange={() => {}} />
          </SiteMdxAllowContext.Provider>
        </ApiClient>
      </CanopyCMSProvider>,
    )
    await act(async () => {})
    const count = view.container.querySelectorAll(
      '[aria-label="Underline"], [title="Underline"]',
    ).length
    view.unmount()
    return count
  }

  it('offers Underline only where the field accepts <u>', async () => {
    const asMdx: EntrySchema = [{ name: 'body', type: 'markdown', renderAs: 'mdx' }]
    expect(await underlineButtons(asMdx)).toBeGreaterThan(0)
    expect(await underlineButtons(asMdx, narrow)).toBe(0)
    expect(
      await underlineButtons([{ name: 'body', type: 'mdx', mdxAllow: { htmlTags: [] } }]),
    ).toBe(0)
    expect(
      await underlineButtons(
        [{ name: 'body', type: 'mdx', mdxAllow: { htmlTags: ['u'] } }],
        narrow,
      ),
    ).toBeGreaterThan(0)
  })

  it('leaves a markdown field the site does not render as MDX alone', async () => {
    expect(await underlineButtons([{ name: 'body', type: 'markdown' }], narrow)).toBeGreaterThan(0)
  })
})
