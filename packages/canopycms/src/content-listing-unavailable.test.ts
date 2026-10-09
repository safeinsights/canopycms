import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { flattenSchema, type FieldConfig, type RootCollectionConfig } from './config'
import { listEntries } from './content-listing'
import { buildContentTree } from './content-tree'
import { ContentStore } from './content-store'
import { generateAIContent } from './ai/generate'
import { mockConsole } from './test-utils/console-spy'

const nameFields: FieldConfig[] = [{ name: 'name', type: 'string' }]

/** `people` holds a `staff` entry and a `contributor` entry; the contributor type is unavailable. */
const schema: RootCollectionConfig = {
  collections: [
    {
      name: 'people',
      path: 'people',
      entries: [
        { name: 'staff', format: 'json', schema: nameFields, default: true },
        {
          name: 'contributor',
          format: 'json',
          schema: [],
          schemaRef: 'contributorSchema',
          unavailable: {
            reason: 'unknown-schema',
            schemaRef: 'contributorSchema',
            metaFile: 'people/.collection.json',
          },
        },
      ],
    },
  ],
}
const flatSchema = flattenSchema(schema, 'content')

describe('adopter-facing reads of a collection with an unavailable entry type', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-unavailable-list-'))
    const dir = path.join(root, 'content', 'people.peopleDir123')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'staff.grace.grAcEgrAcE12.json'), '{"name":"Grace"}')
    await fs.writeFile(path.join(dir, 'contributor.ada.aDaaDaaDaa12.json'), '{"name":"Ada"}')
  })

  it('listEntries leaves its entries out and keeps the rest', async () => {
    const items = await listEntries(root, flatSchema, 'content')
    expect(items.map((item) => item.slug)).toEqual(['grace'])
  })

  it('buildContentTree leaves its entries out and keeps the rest', async () => {
    const tree = await buildContentTree(root, flatSchema, 'content')
    const slugs = JSON.stringify(tree)
    expect(slugs).toContain('grace')
    expect(slugs).not.toContain('"ada"')
  })

  it('AI content leaves its entries out quietly and keeps the rest', async () => {
    const output = mockConsole()
    try {
      const { files } = await generateAIContent({
        store: new ContentStore(root, flatSchema, { contentRootName: 'content' }),
        flatSchema,
        contentRoot: 'content',
      })
      const all = [...files.values()].join('\n')
      expect(all).toContain('Grace')
      expect(all).not.toContain('Ada')
      expect(output.all().warn).toEqual([])
    } finally {
      output.restore()
    }
  })
})
