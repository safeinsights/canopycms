/**
 * What the rich-text editor can write in a field whose MDX allowlist narrows its HTML tags: no
 * toolbar action or shortcut adds a tag the server would refuse, and stored content is left alone.
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

  describe('in a nested editor', () => {
    // Under jsdom a nested edit does not reach the export, so these read the nested editor's state.
    const formatOf = (editor: Editor, text: string) =>
      editor.getEditorState().read(() => {
        const lx = mdx.lexical
        const queue = [...lx.$getRoot().getChildren()]
        while (queue.length > 0) {
          const node = queue.shift()
          if (lx.$isTextNode(node) && node.getTextContent().includes(text)) return node.getFormat()
          if (lx.$isElementNode(node)) queue.push(...node.getChildren())
        }
        throw new Error(`no text node "${text}"`)
      })
    const underline = 8

    /** Selects `text` in `editor`, with the format a real selection change gives it, and toggles. */
    const toggleUnderline = async (editor: Editor, text: string) => {
      const lx = mdx.lexical
      await act(async () => {
        editor.update(
          () => {
            const queue = [...lx.$getRoot().getChildren()]
            while (queue.length > 0) {
              const node = queue.shift()
              const start = lx.$isTextNode(node) ? node.getTextContent().indexOf(text) : -1
              if (lx.$isTextNode(node) && start >= 0) {
                node.select(start, start + text.length).format = node.getFormat()
                return
              }
              if (lx.$isElementNode(node)) queue.push(...node.getChildren())
            }
          },
          { discrete: true },
        )
        editor.dispatchCommand(lx.FORMAT_TEXT_COMMAND, 'underline')
      })
    }

    const nestedOf = async (body: string, htmlTags?: ReadonlySet<string>) => {
      const mounted = await mountEditor(body, htmlTags)
      const [root, nested] = mounted.editors()
      if (root === undefined || nested === undefined) throw new Error('no nested editor')
      return { mounted, root, nested }
    }

    it('refuses adding a refused format, and adds an allowed one', async () => {
      const body = '<Callout>\n  alpha words\n</Callout>\n'
      const allowed = await nestedOf(body)
      try {
        await toggleUnderline(allowed.nested, 'alpha')
        expect(formatOf(allowed.nested, 'alpha')).toBe(underline)
      } finally {
        allowed.mounted.unmount()
      }
      const refused = await nestedOf(body, new Set())
      try {
        await toggleUnderline(refused.nested, 'alpha')
        expect(formatOf(refused.nested, 'alpha')).toBe(0)
      } finally {
        refused.mounted.unmount()
      }
    })

    it('lets a refused format be removed', async () => {
      const { mounted, nested } = await nestedOf(
        '<Callout>\n  <u>alpha</u> words\n</Callout>\n',
        new Set(),
      )
      try {
        await toggleUnderline(nested, 'alpha')
        expect(formatOf(nested, 'alpha')).toBe(0)
      } finally {
        mounted.unmount()
      }
    })

    it('decides by the selection the command acts on, when dispatched in an update', async () => {
      const { mounted, nested } = await nestedOf(
        '<Callout>\n  <u>alpha</u> words\n</Callout>\n',
        new Set(),
      )
      try {
        const lx = mdx.lexical
        const select = (text: string) => {
          const queue = [...lx.$getRoot().getChildren()]
          while (queue.length > 0) {
            const node = queue.shift()
            if (lx.$isTextNode(node) && node.getTextContent().includes(text)) {
              const start = node.getTextContent().indexOf(text)
              node.select(start, start + text.length).format = node.getFormat()
              return
            }
            if (lx.$isElementNode(node)) queue.push(...node.getChildren())
          }
        }
        await act(async () => {
          nested.update(() => select('alpha'), { discrete: true })
          nested.update(
            () => {
              select('words')
              nested.dispatchCommand(lx.FORMAT_TEXT_COMMAND, 'underline')
            },
            { discrete: true },
          )
        })
        expect(formatOf(nested, 'words')).toBe(0)
      } finally {
        mounted.unmount()
      }
    })

    it('decides by the nested selection, not the root one', async () => {
      const { mounted, root, nested } = await nestedOf(
        'Some <u>under</u> words.\n\n<Callout>\n  alpha words\n</Callout>\n',
        new Set(),
      )
      try {
        const lx = mdx.lexical
        await act(async () => {
          root.update(
            () => {
              const paragraph = lx.$getRoot().getFirstChild()
              const under = lx.$isElementNode(paragraph)
                ? paragraph.getChildren().find((node) => node.getTextContent() === 'under')
                : undefined
              if (lx.$isTextNode(under)) {
                under.select(0, under.getTextContentSize()).format = under.getFormat()
              }
            },
            { discrete: true },
          )
        })
        await toggleUnderline(nested, 'alpha')
        expect(formatOf(nested, 'alpha')).toBe(0)
      } finally {
        mounted.unmount()
      }
    })
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

  it('lets a refused format be removed', async () => {
    const mounted = await mountEditor('Some <u>under</u> words.\n', new Set())
    try {
      const [root] = mounted.editors()
      if (root === undefined) throw new Error('no Lexical editor')
      const lx = mdx.lexical
      await act(async () => {
        root.update(
          () => {
            const paragraph = lx.$getRoot().getFirstChild()
            const under = lx.$isElementNode(paragraph)
              ? paragraph.getChildren().find((node) => node.getTextContent() === 'under')
              : undefined
            if (!lx.$isTextNode(under)) throw new Error('no underlined text node')
            const selection = under.select(0, under.getTextContentSize())
            // A real selection change gives the selection its text's format, which Lexical's
            // toggle reads to decide between adding and removing.
            selection.format = under.getFormat()
          },
          { discrete: true },
        )
        root.dispatchCommand(lx.FORMAT_TEXT_COMMAND, 'underline')
      })
      expect(mounted.exported().trim()).toBe('Some under words.')
    } finally {
      mounted.unmount()
    }
  })

  it('refuses setting a refused format explicitly', async () => {
    const mounted = await mountEditor('Some words.\n', new Set())
    try {
      const [root] = mounted.editors()
      if (root === undefined) throw new Error('no Lexical editor')
      const lx = mdx.lexical
      await applyFormat(root, 'words', 'bold')
      await act(async () => {
        root.dispatchCommand(lx.SET_TEXT_FORMAT_COMMAND, { underline: true })
      })
      expect(mounted.exported()).not.toContain('<u>')
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

  it('leaves an md entry body typed mdx alone, as the server checks it as markdown', async () => {
    const fields: EntrySchema = [{ name: 'body', type: 'mdx', isBody: true }]
    expect(await underlineButtons(fields, narrow, 'md')).toBeGreaterThan(0)
  })

  it('reads a nested field named like the body by its own type', async () => {
    const fields: EntrySchema = [
      { name: 'body', type: 'markdown', isBody: true, renderAs: 'mdx' },
      { name: 'meta', type: 'object', fields: [{ name: 'body', type: 'markdown' }] },
    ]
    const view = render(
      <CanopyCMSProvider>
        <ApiClient>
          <SiteMdxAllowContext.Provider value={narrow}>
            <FormRenderer
              fields={fields}
              value={{ body: 'Text', meta: { body: 'Text' } }}
              onChange={() => {}}
              format="mdx"
            />
          </SiteMdxAllowContext.Provider>
        </ApiClient>
      </CanopyCMSProvider>,
    )
    await act(async () => {})
    const toolbars = view.container.querySelectorAll('[role="toolbar"]')
    const underlines = [...toolbars].map(
      (toolbar) => toolbar.querySelectorAll('[aria-label="Underline"], [title="Underline"]').length,
    )
    view.unmount()
    expect(underlines).toHaveLength(2)
    expect(underlines.sort()).toEqual([0, 1])
  })
})
