/**
 * What the rich-text toolbar can write in a field whose MDX allowlist narrows its HTML tags: the
 * editor offers, and saves, no tag the server would refuse.
 */
import React, { Suspense } from 'react'
import { act, render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import * as mdx from '@mdxeditor/editor'
import type { MDXEditorMethods } from '@mdxeditor/editor'
import type { ContentFormat, EntrySchema, MdxAllowlist } from '../../config'
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

type Mounted = {
  editors: () => Editor[]
  exported: () => string
  onChange: ReturnType<typeof vi.fn>
  setHtmlTags: (htmlTags?: ReadonlySet<string>) => void
  unmount: () => void
}

async function mountEditor(body: string, htmlTags?: ReadonlySet<string>): Promise<Mounted> {
  const editorRef = React.createRef<MDXEditorMethods>()
  const onChange = vi.fn()
  const tree = (tags?: ReadonlySet<string>) => (
    <CanopyCMSProvider>
      <ApiClient>
        <Suspense fallback={null}>
          <MDXEditorLazy
            markdown={body}
            onChange={onChange}
            onError={({ error }) => {
              throw new Error(error)
            }}
            onInsert={(insert) => insert()}
            editorRef={editorRef}
            imageUploadHandler={() => Promise.reject(new Error('no uploads in this test'))}
            imagePreviewHandler={(src) => Promise.resolve(src)}
            htmlTags={tags}
          />
        </Suspense>
      </ApiClient>
    </CanopyCMSProvider>
  )
  const view = render(tree(htmlTags))
  await act(async () => {})
  return {
    // The root editor first, then nested ones (table cells, component children).
    editors: () =>
      [...view.container.querySelectorAll('[contenteditable]')].flatMap(
        (element: Element & { __lexicalEditor?: Editor }) =>
          element.__lexicalEditor ? [element.__lexicalEditor] : [],
      ),
    exported: () => {
      const markdown = editorRef.current?.getMarkdown()
      if (markdown === undefined) throw new Error('the editor did not mount')
      return markdown
    },
    onChange,
    setHtmlTags: (tags) => view.rerender(tree(tags)),
    unmount: () => view.unmount(),
  }
}

/** Selects `word` in `editor`'s first paragraph and applies `format`, as the toolbar or Cmd+U does. */
async function applyFormat(editor: Editor, word: string, format: TextFormat) {
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
}

async function formatAndExport(
  body: string,
  word: string,
  format: TextFormat,
  htmlTags?: ReadonlySet<string>,
): Promise<string> {
  const mounted = await mountEditor(body, htmlTags)
  try {
    const [root] = mounted.editors()
    if (root === undefined) throw new Error('no Lexical editor')
    await applyFormat(root, word, format)
    return mounted.exported()
  } finally {
    mounted.unmount()
  }
}

describe('a field whose allowlist leaves out a formatting tag', () => {
  it.each([
    ['underline', 'u'],
    ['superscript', 'sup'],
    ['subscript', 'sub'],
  ] as const)('refuses %s applied by command', async (format, tag) => {
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

  it('refuses the format in a nested editor too', async () => {
    const mounted = await mountEditor('<Callout>\n  alpha words\n</Callout>\n', new Set())
    try {
      const nested = mounted.editors()[1]
      if (nested === undefined) throw new Error('no nested editor')
      await applyFormat(nested, 'alpha', 'underline')
      expect(mounted.exported()).not.toContain('<u>')
    } finally {
      mounted.unmount()
    }
  })

  it('leaves a stored tag alone, and reports no change on opening', async () => {
    const body = 'Some <u>under</u> and H<sub>2</sub>O.\n'
    const mounted = await mountEditor(body, new Set())
    try {
      expect(mounted.exported().trim()).toBe(body.trim())
      expect(mounted.onChange.mock.calls.filter(([, initial]) => initial === false)).toEqual([])
    } finally {
      mounted.unmount()
    }
  })

  it('follows a change of allowed tags on the same editor', async () => {
    const mounted = await mountEditor('Alpha beta gamma.\n', new Set(['u']))
    try {
      const root = () => mounted.editors()[0] as Editor
      mounted.setHtmlTags(new Set())
      await act(async () => {})
      await applyFormat(root(), 'Alpha', 'underline')
      expect(mounted.exported()).not.toContain('<u>')
      mounted.setHtmlTags(undefined)
      await act(async () => {})
      await applyFormat(root(), 'gamma', 'underline')
      expect(mounted.exported()).toContain('<u>gamma</u>')
    } finally {
      mounted.unmount()
    }
  })
})

describe('the toolbar through FormRenderer', () => {
  const underlineButtons = async (
    fields: EntrySchema,
    site?: MdxAllowlist,
    format?: ContentFormat,
  ) => {
    const view = render(
      <CanopyCMSProvider>
        <ApiClient>
          <SiteMdxAllowContext.Provider value={site}>
            <FormRenderer
              fields={fields}
              value={{ body: 'Text' }}
              onChange={() => {}}
              format={format}
            />
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

  it('leaves an executable field alone', async () => {
    const fields: EntrySchema = [{ name: 'body', type: 'mdx', executable: true }]
    expect(await underlineButtons(fields, narrow)).toBeGreaterThan(0)
  })

  it('trims the body of an mdx entry, whatever its field type', async () => {
    const fields: EntrySchema = [{ name: 'body', type: 'markdown', isBody: true }]
    expect(await underlineButtons(fields, narrow, 'md')).toBeGreaterThan(0)
    expect(await underlineButtons(fields, narrow, 'mdx')).toBe(0)
  })
})
