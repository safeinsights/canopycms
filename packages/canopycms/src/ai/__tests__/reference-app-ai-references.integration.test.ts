import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { flattenSchema, type FieldConfig } from '../../config'
import { ContentStore } from '../../content-store'
import { loadCollectionMetaFiles, resolveCollectionReferences } from '../../schema/meta-loader'
import type { EntrySchemaRegistry } from '../../schema/types'
import { generateAIContent } from '../generate'

// `apps/example1`'s real content tree, read as DATA: the package gains no import of the app's
// code (AGENTS.md's touchpoint rule). Its field schemas live in `app/schemas.ts`, so the entry
// types this suite renders get stand-ins below that copy the fields it asserts on; every other
// entry type gets an empty field list.

const here = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE1_CONTENT = path.resolve(here, '../../../../../apps/example1/content')

const STAND_IN_SCHEMAS: Record<string, FieldConfig[]> = {
  author: [
    { name: 'name', type: 'string', label: 'Name' },
    { name: 'bio', type: 'string', label: 'Bio' },
  ],
  snippet: [
    { name: 'title', type: 'string', label: 'Title' },
    { name: 'ctaText', type: 'string', label: 'Button Text' },
  ],
  post: [
    { name: 'title', type: 'string', label: 'Title' },
    {
      name: 'author',
      type: 'reference',
      label: 'Author',
      collections: ['authors'],
      displayField: 'name',
    },
    { name: 'body', type: 'markdown', label: 'Body', isBody: true },
    {
      name: 'blocks',
      type: 'block',
      templates: [
        {
          name: 'sharedCta',
          label: 'Shared CTA',
          fields: [
            { name: 'snippet', type: 'reference', label: 'CTA Snippet', entryTypes: ['snippet'] },
          ],
        },
      ],
    },
  ],
}

describe('apps/example1 AI content renders reference fields as links', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-example1-ai-'))
    // Copied, not read in place: building the id index writes a marker under `.canopy-meta/`.
    await fs.cp(EXAMPLE1_CONTENT, path.join(root, 'content'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('shows the hello-world post author and its shared CTA snippet by title, linked', async () => {
    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const registry: EntrySchemaRegistry = {}
    for (const collection of [metaFiles.root, ...metaFiles.collections]) {
      for (const entry of collection?.entries ?? []) {
        if (typeof entry.schema === 'string') {
          registry[entry.schema] = STAND_IN_SCHEMAS[entry.schema] ?? []
        }
      }
    }
    const flatSchema = flattenSchema(resolveCollectionReferences(metaFiles, registry), 'content')
    const store = new ContentStore(root, flatSchema)

    const { files } = await generateAIContent({ store, flatSchema, contentRoot: 'content' })
    const post = files.get('posts/hello-world.md')

    expect(post).toBeDefined()
    expect(post).toContain('**Author:** [Alice](/authors/alice)')
    expect(post).not.toContain('5NVkkrB1MJUv')
    expect(post).toContain(
      '### Shared CTA\n\n#### CTA Snippet\n\n[Try CanopyCMS](/snippets/try-canopy)',
    )
    // A link, not an inlined copy: the snippet's own button text stays in the snippet's file.
    expect(post).not.toContain('Get started')
    expect(files.get('snippets/try-canopy.md')).toContain('Get started')
  })
})
