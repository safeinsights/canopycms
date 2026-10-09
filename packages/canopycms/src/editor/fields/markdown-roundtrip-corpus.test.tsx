/**
 * The sample sites' and `__fixtures__/markdown-corpus`'s markdown bodies through the rich-text
 * editor's load → export → save cycle. `MDXEditorLazy`, MarkdownField's editor, mounts each body
 * without crashing; a body it reports opens as source and is listed in `ROUTED_TO_SOURCE`; any
 * other body's export has the same top-level blocks by `markdownBlocks` (the save splice's
 * comparison, so formatting alone never differs); and the export saved by `serializeFrontmatter`
 * writes its md/mdx file byte for byte. A listed body fails the run once it comes out right.
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

const USERS_V1 =
  'apps/example1/content/docs.bChqT78gcaLd/api.meiuwxTSo7UN/v1.cz5H1nu9FEer/doc.users.7yidfX3DKTbR.json#body'
const USERS_V2 =
  'apps/example1/content/docs.bChqT78gcaLd/api.meiuwxTSo7UN/v2.muwmyafM6mEJ/doc.users.ppqJw61uKkV5.json#body'

/** Bodies that open as source: a fragment of the reason MarkdownField shows, and any task. */
const ROUTED_TO_SOURCE: Record<string, { reason: string; task?: string }> = {
  [`${FIXTURES}/component-with-import.mdx`]: { reason: 'import/export statements' },
  [`${FIXTURES}/code-fence-language.md`]: {
    reason: '{"type":"code"',
    task: `${TASKS}/rich-text-code-fence-opens-source.md`,
  },
  [`${FIXTURES}/code-fence-meta.md`]: {
    reason: '{"type":"code"',
    task: `${TASKS}/rich-text-code-fence-opens-source.md`,
  },
  [USERS_V1]: { reason: '{"type":"code"', task: `${TASKS}/rich-text-code-fence-opens-source.md` },
  [USERS_V2]: { reason: '{"type":"code"', task: `${TASKS}/rich-text-code-fence-opens-source.md` },
  [`${FIXTURES}/reference-link.md`]: {
    reason: '{"type":"linkReference"',
    task: `${TASKS}/rich-text-reference-links-open-source.md`,
  },
  [`${FIXTURES}/html-comment.md`]: {
    reason: 'Unexpected character `!`',
    task: `${TASKS}/rich-text-md-body-parsed-as-mdx.md`,
  },
}

/** Bodies whose export means something else, each with its task. Their saves are not checked. */
const KNOWN_EXPORT_DIFFERENCES: Record<string, string> = {
  [`${FIXTURES}/list-item-paragraphs.md`]: `${TASKS}/rich-text-merges-block-paragraphs.md`,
  [`${FIXTURES}/quote-paragraphs.md`]: `${TASKS}/rich-text-merges-block-paragraphs.md`,
  [`${FIXTURES}/adjacent-lists.md`]: `${TASKS}/rich-text-merges-adjacent-lists.md`,
  [`${FIXTURES}/ordered-list-start.md`]: `${TASKS}/rich-text-ordered-list-start-reset.md`,
  [`${FIXTURES}/strikethrough-code.md`]: `${TASKS}/rich-text-inline-formatting-split.md`,
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
      // The body as the content store splits it, and the data as a save request carries it (JSON).
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
