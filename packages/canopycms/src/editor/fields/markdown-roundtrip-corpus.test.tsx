/**
 * The sample sites' and `__fixtures__/markdown-corpus`'s markdown bodies through the rich-text
 * editor's load → export → save cycle. `MDXEditorLazy`, MarkdownField's editor, mounts each body
 * without crashing; a body it reports opens as source and is listed in `ROUTED_TO_SOURCE`; any
 * other body's export has the same top-level blocks by `markdownBlocks` (the save splice's
 * comparison, which ignores marker and escape style); and the export saved by
 * `serializeFrontmatter` writes its md/mdx file byte for byte. A listed body fails the run once it
 * comes out right. List-item and quote shapes follow: those MDXEditor merges or reorders open as
 * source (`rearrangedBlocks` in `mdx-jsx-support.tsx`), and the rest export what they mean but for
 * `spread`.
 *
 * Bundling bugs are out of reach: request 86 crashed only under Turbopack's chunking. See
 * `.claude/future-tasks/editor-tests-miss-adopter-runtime-stack.md`.
 */
import fs from 'node:fs'
import path from 'node:path'
import React, { Suspense } from 'react'
import { act, render } from '@testing-library/react'
import matter from 'gray-matter'
import { beforeAll, expect, it, vi } from 'vitest'

import type { MDXEditorMethods } from '@mdxeditor/editor'
import { serializeFrontmatter } from '../../utils/content-serialize'
import { getErrorMessage } from '../../utils/error'
import { markdownBlocks, type MarkdownBodyFormat } from '../../utils/markdown-body-splice'
import { EditorErrorBoundary } from '../components/EditorErrorBoundary'
import { createApiClientWrapper, setupMockApiClient } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MDXEditorLazy } from './MarkdownField'
// Preloads MarkdownField's lazy chunk, as MarkdownField.test.tsx explains.
import '@mdxeditor/editor'

vi.mock('../../api', async () => ({
  ...(await vi.importActual('../../api')),
  createApiClient: vi.fn(),
}))
vi.mock('./entry-link', () => ({ InsertEntryLink: () => null }))
vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const FIXTURES = 'packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus'
const TASKS = '.claude/future-tasks'

/** Every sample site's content tree, and the fixtures; relative to the repo root. */
const CORPUS_ROOTS = [
  ...fs
    .readdirSync(path.join(REPO_ROOT, 'apps'))
    .map((app) => path.join('apps', app, 'content'))
    .filter((dir) => fs.existsSync(path.join(REPO_ROOT, dir))),
  FIXTURES,
]

/** Bodies that open as source: a fragment of the reason MarkdownField shows, and any task. */
const ROUTED_TO_SOURCE: Record<string, { reason: string; task?: string }> = {
  [`${FIXTURES}/component-with-import.mdx`]: { reason: 'import/export statements' },
  [`${FIXTURES}/reference-link.md`]: {
    reason: '{"type":"linkReference"',
    task: `${TASKS}/rich-text-reference-links-open-source.md`,
  },
  [`${FIXTURES}/html-comment.md`]: {
    reason: 'Unexpected character `!`',
    task: `${TASKS}/rich-text-md-body-parsed-as-mdx.md`,
  },
  [`${FIXTURES}/list-item-paragraphs.md`]: {
    reason: 'a list item with content after its nested list',
    task: `${TASKS}/rich-text-merges-block-paragraphs.md`,
  },
}

/** Bodies whose export means something else, each with its task. Their saves are not checked. */
const KNOWN_EXPORT_DIFFERENCES: Record<string, string> = {
  [`${FIXTURES}/adjacent-lists.md`]: `${TASKS}/rich-text-merges-adjacent-lists.md`,
  [`${FIXTURES}/ordered-list-start.md`]: `${TASKS}/rich-text-ordered-list-start-reset.md`,
  [`${FIXTURES}/strong-link.md`]: `${TASKS}/rich-text-inline-formatting-split.md`,
  [`${FIXTURES}/code-span-url.md`]: `${TASKS}/rich-text-autolinks-code-spans.md`,
}

interface CorpusBody {
  /** Repo-relative file path, plus `#key.path` for a markdown field value in the entry's data. */
  readonly name: string
  readonly body: string
  readonly format: MarkdownBodyFormat
  /** The md/mdx file the body is saved into; a JSON value is written as the editor sends it. */
  readonly file?: { readonly raw: string; readonly data: Record<string, unknown> }
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

/** The `body` strings in entry data: every markdown field in the sample schemas is a `body`. */
function jsonBodies(value: unknown, at: string): { key: string; body: string }[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => jsonBodies(item, `${at}.${i}`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'body' && typeof child === 'string'
      ? [{ key: `${at}.${key}`, body: child }]
      : jsonBodies(child, `${at}.${key}`),
  )
}

function collectCorpus(): CorpusBody[] {
  const files = CORPUS_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    .sort()
  return files.flatMap((name): CorpusBody[] => {
    const ext = path.extname(name)
    if (!['.md', '.mdx', '.json'].includes(ext)) return []
    const raw = fs.readFileSync(path.join(REPO_ROOT, name), 'utf8')
    if (ext === '.md' || ext === '.mdx') {
      // The body as the content store splits it, and the data after JSON, as the API carries it.
      const parsed = matter(raw, {})
      const data = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>
      const fieldBodies = jsonBodies(data, '').map(
        ({ key, body }): CorpusBody => ({
          name: `${name}#${key.slice(1)}`,
          body,
          format: 'md',
        }),
      )
      return [
        { name, body: parsed.content, format: ext === '.mdx' ? 'mdx' : 'md', file: { raw, data } },
        ...fieldBodies,
      ]
    }
    let entry: unknown
    try {
      entry = JSON.parse(raw)
    } catch (err: unknown) {
      throw new Error(`${name}: ${getErrorMessage(err)}`)
    }
    return jsonBodies(entry, '').map(({ key, body }) => ({
      name: `${name}#${key.slice(1)}`,
      body,
      format: 'md',
    }))
  })
}

let ApiClient: React.FC<{ children: React.ReactNode }>

beforeAll(async () => {
  ApiClient = createApiClientWrapper(await setupMockApiClient())
})

type EditorResult = { exported: string } | { routedToSource: string }

/** Mounts the editor on `body` as MarkdownField does, and reads what it exports or reports. */
async function loadAndExport(body: string): Promise<EditorResult> {
  const editorRef = React.createRef<MDXEditorMethods>()
  let reported: string | undefined
  let crashed: string | undefined
  const view = render(
    <CanopyCMSProvider>
      <ApiClient>
        <EditorErrorBoundary
          context={{ boundary: 'rich-text' }}
          fallback={() => null}
          onCaught={({ error }) => {
            crashed = getErrorMessage(error)
          }}
        >
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
        </EditorErrorBoundary>
      </ApiClient>
    </CanopyCMSProvider>,
  )
  await act(async () => {})
  const exported = editorRef.current?.getMarkdown()
  view.unmount()
  if (crashed !== undefined) throw new Error(`the editor crashed: ${crashed}`)
  if (reported !== undefined) return { routedToSource: reported }
  if (exported === undefined) throw new Error('the editor did not mount')
  return { exported }
}

/**
 * Whether the export means what the body does, block by block, and each side's block texts for a
 * failure's diff: the export's written as the body's text wherever a block means the same.
 */
function compareBlocks(body: string, exported: string, format: MarkdownBodyFormat) {
  const before = markdownBlocks(body, format)
  const after = markdownBlocks(exported, format)
  if (before === undefined || after === undefined) {
    return { same: false, before: [body], after: [exported] }
  }
  return {
    same: after.length === before.length && after.every((a, i) => a.meaning === before[i]?.meaning),
    before: before.map((b) => b.text),
    after: after.map((a, i) =>
      a.meaning === before[i]?.meaning ? (before[i]?.text ?? a.text) : a.text,
    ),
  }
}

const corpus = collectCorpus()

it('collects the sample sites and fixtures, and every listed body names a live task', () => {
  const names = corpus.map((c) => c.name)
  expect(names.filter((name) => name.startsWith('apps/')).length).toBeGreaterThan(10)
  expect(names.filter((name) => name.endsWith('.mdx')).length).toBeGreaterThan(1)
  const listed = [
    ...Object.entries(ROUTED_TO_SOURCE).map(([name, { task }]) => [name, task] as const),
    ...Object.entries(KNOWN_EXPORT_DIFFERENCES),
  ]
  for (const [name, task] of listed) {
    expect.soft(names, `${name} is not in the corpus`).toContain(name)
    if (task !== undefined) {
      expect.soft(fs.existsSync(path.join(REPO_ROOT, task)), `${task} does not exist`).toBe(true)
    }
  }
})

// A mount of the full editor takes seconds on a loaded runner, past the default timeout.
for (const { name, body, format, file } of corpus) {
  it(`${name}: loads, exports what it means, and saves byte for byte`, async () => {
    const result = await loadAndExport(body)

    const routed = 'routedToSource' in result ? result.routedToSource : undefined
    const expectedRoute = ROUTED_TO_SOURCE[name]
    if (expectedRoute === undefined) {
      expect.soft(routed, `${name} opens as source`).toBeUndefined()
    } else {
      expect
        .soft(routed, `${name} no longer opens as source as listed`)
        .toContain(expectedRoute.reason)
    }

    const knownDifference = KNOWN_EXPORT_DIFFERENCES[name]
    if ('exported' in result) {
      const { same, before, after } = compareBlocks(body, result.exported, format)
      if (knownDifference === undefined) {
        expect
          .soft({ same, blocks: after }, `${name}: the export means something else`)
          .toEqual({ same: true, blocks: before })
      } else {
        expect
          .soft(same, `${name} now exports what it means; unlist it and resolve its task`)
          .toBe(false)
      }
    }

    if (file !== undefined && knownDifference === undefined) {
      const sent = 'exported' in result ? result.exported : body
      expect
        .soft(serializeFrontmatter(sent, file.data, file.raw, format), `${name}: the saved file`)
        .toBe(file.raw)
    }
  }, 30_000)
}

const FENCE = '```'
const TABLE = '| x |\n  | - |\n  | 1 |'

/** List items MDXEditor merges or reorders, with a fragment of the reason. */
const REARRANGED_SHAPES: Record<string, { body: string; reason: string }> = {
  'a paragraph, a nested list, a paragraph': {
    body: '- a\n  - b\n\n  c\n',
    reason: 'list item with content after its nested list',
  },
  'a nested list, then a paragraph': {
    body: '- - a\n\n  c\n',
    reason: 'list item with content after its nested list',
  },
  'two nested lists': {
    body: '- a\n  - b\n\n  * c\n',
    reason: 'list item with content after its nested list',
  },
  'a paragraph, then a horizontal rule': {
    body: '- a\n\n  ***\n',
    reason: 'list item with a paragraph followed by a horizontal rule',
  },
  'a quote, then a paragraph': {
    body: '- > q\n\n  c\n',
    reason: 'list item with a quote followed by a paragraph',
  },
  'a quote, then a quote': {
    body: '- > a\n\n  > b\n',
    reason: 'list item with a quote followed by a quote',
  },
  'a quote, then a table': {
    body: `- > q\n\n  ${TABLE}\n`,
    reason: 'list item with a quote followed by a table',
  },
  'a table, then a paragraph': {
    body: `- ${TABLE}\n\n  c\n`,
    reason: 'list item with a table followed by a paragraph',
  },
  'a table, then a table': {
    body: `- ${TABLE}\n\n  ${TABLE}\n`,
    reason: 'list item with a table followed by a table',
  },
  // An element's nested editor writes its children back only once they are edited.
  'a nested list, then a paragraph, inside an element.mdx': {
    body: '<Callout>\n\n- - a\n\n  c\n\n</Callout>\n',
    reason: 'list item with content after its nested list',
  },
}

/** List items and quotes MDXEditor keeps, but for `spread`: it writes every list tight. */
const KEPT_SHAPES: Record<string, string> = {
  'a tight list': '- a\n- b\n',
  'a loose list': '- a\n\n- b\n',
  'a task list': '- [ ] a\n- [x] b\n',
  'a paragraph, then a nested list': '- a\n  - b\n  - c\n',
  'a paragraph, then a nested list, loose': '- a\n\n  - b\n\n- d\n',
  'a paragraph, then a nested ordered list': '1. a\n   - b\n2. c\n',
  'a nested list alone': '- - a\n  - b\n',
  'a paragraph, then a code block': `- a\n\n  ${FENCE}\n  x\n  ${FENCE}\n`,
  'a code block, then a paragraph': `- ${FENCE}\n  x\n  ${FENCE}\n\n  c\n`,
  'a paragraph, a code block, a paragraph': `- a\n\n  ${FENCE}\n  x\n  ${FENCE}\n\n  c\n`,
  'a paragraph, then an element.mdx': '- a\n\n  <Callout>\n    x\n  </Callout>\n',
  'an element, then a paragraph.mdx': '- <Callout>\n    x\n  </Callout>\n\n  c\n',
  'a paragraph, an element, a paragraph.mdx': '- a\n\n  <Callout>\n    x\n  </Callout>\n\n  c\n',
  'a paragraph, then a quote': '- a\n\n  > q\n',
  'a quote, then a list': '- > q\n\n  - b\n',
  'a quote, then a heading': '- > q\n\n  # h\n',
  'a paragraph, then a table': `- a\n\n  ${TABLE}\n`,
  'a table, then a quote': `- ${TABLE}\n\n  > q\n`,
  'a table, then a horizontal rule': `- ${TABLE}\n\n  ***\n`,
  'a horizontal rule, then a paragraph': '- ***\n\n  c\n',
  'a heading, then a paragraph': '- # h\n\n  c\n',
  'a quote with one paragraph': '> a\n',
  'a quote with a list': '> - a\n> - b\n',
  'a quote with a code block': `> ${FENCE}\n> x\n> ${FENCE}\n`,
  'a quote with a heading': '> # h\n',
  'a quote in a quote': '> > a\n',
  'a quote with a table': '> | x |\n> | - |\n> | 1 |\n',
  'a quote with an element.mdx': '> <Callout>\n>   x\n> </Callout>\n',
  'an empty quote': '>\n',
  'a list inside an element.mdx': '<Callout>\n\n- a\n- b\n\n</Callout>\n',
  'a quote inside an element.mdx': '<Callout>\n\n> a\n\n</Callout>\n',
  'two paragraphs in a list item': '- a\n\n  b\n',
  'two paragraphs in an ordered item': '1. a\n\n   b\n',
  'two paragraphs in a task item': '- [ ] a\n\n  b\n',
  'two paragraphs in a nested item': '- a\n  - b\n\n    c\n',
  'a paragraph, then a paragraph holding only an element.mdx': '1. a\n\n   <Badge>new</Badge>\n',
  'a quote with two paragraphs': '> a\n>\n> b\n',
  'a quote with a paragraph and a list': '> a\n>\n> - b\n',
  'a quote with a list and a paragraph': '> - a\n>\n> c\n',
  'a quote with a code block and a paragraph': `> ${FENCE}\n> x\n> ${FENCE}\n>\n> c\n`,
  'a quote with a paragraph and a horizontal rule': '> a\n>\n> ***\n',
  'a quote in a quote, with two paragraphs': '> > a\n> >\n> > b\n',
  'a quote with two paragraphs in a list item': '- > a\n  >\n  > b\n',
  // An edit inside these two elements is `MarkdownField.test.tsx`'s nested-edit test.
  'a list item with two paragraphs inside an element.mdx':
    '<Callout>\n\n- a\n\n  b\n\n</Callout>\n',
  'a quote with two paragraphs inside an element.mdx': '<Callout>\n\n> a\n>\n> b\n\n</Callout>\n',
}

const formatOf = (name: string): MarkdownBodyFormat => (name.endsWith('.mdx') ? 'mdx' : 'md')

const withoutSpread = (meaning: string) =>
  JSON.stringify(
    JSON.parse(meaning, (key, value: unknown) => (key === 'spread' ? undefined : value)),
  )

for (const [name, { body, reason }] of Object.entries(REARRANGED_SHAPES)) {
  it(`opens ${name} as source`, async () => {
    const result = await loadAndExport(body)
    expect('routedToSource' in result ? result.routedToSource : result.exported).toContain(reason)
  }, 30_000)
}

for (const [name, body] of Object.entries(KEPT_SHAPES)) {
  it(`opens ${name} in rich text, and exports what it means`, async () => {
    const result = await loadAndExport(body)
    if (!('exported' in result)) throw new Error(`opens as source: ${result.routedToSource}`)
    const meanings = (text: string) =>
      markdownBlocks(text, formatOf(name))?.map((block) => withoutSpread(block.meaning))
    expect(meanings(result.exported)).toEqual(meanings(body))
  }, 30_000)
}
