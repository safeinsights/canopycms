import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { flattenSchema, type FieldConfig, type RootCollectionConfig } from './config'
import { ContentStore } from './content-store'
import { SchemaUnavailableError } from './schema/schema-unavailable-error'
import { unsafeAsLogicalPath, unsafeAsSlug } from './paths/test-utils'

const people = unsafeAsLogicalPath('content/people')
const articles = unsafeAsLogicalPath('content/articles')
const ada = unsafeAsSlug('ada')
const intro = unsafeAsSlug('intro')

const contributorFields: FieldConfig[] = [{ name: 'name', type: 'string' }]

/** A schema whose `contributor` entry type is resolved, or marked unavailable as a degraded resolve marks it. */
const schemaWith = (contributorAvailable: boolean): RootCollectionConfig => ({
  collections: [
    {
      name: 'people',
      path: 'people',
      entries: [
        { name: 'staff', format: 'json', schema: contributorFields },
        contributorAvailable
          ? { name: 'contributor', format: 'json', schema: contributorFields, default: true }
          : {
              name: 'contributor',
              format: 'json',
              schema: [],
              schemaRef: 'contributorSchema',
              default: true,
              unavailable: {
                reason: 'unknown-schema',
                schemaRef: 'contributorSchema',
                metaFile: 'people/.collection.json',
              },
            },
      ],
    },
    {
      name: 'articles',
      path: 'articles',
      entries: [
        {
          name: 'article',
          format: 'json',
          schema: [
            { name: 'title', type: 'string' },
            { name: 'author', type: 'reference', collections: ['people'] } as FieldConfig,
          ],
        },
      ],
    },
  ],
})

describe('ContentStore with an unavailable entry type', () => {
  let root: string
  let store: ContentStore
  let adaId: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-unavailable-'))
    const healthy = new ContentStore(root, flattenSchema(schemaWith(true), 'content'))
    await healthy.write(people, ada, { format: 'json', data: { name: 'Ada' } }, 'contributor')
    adaId = String(await healthy.getIdForEntry(people, ada))
    await healthy.write(
      people,
      unsafeAsSlug('grace'),
      { format: 'json', data: { name: 'Grace' } },
      'staff',
    )
    await healthy.write(
      articles,
      intro,
      { format: 'json', data: { title: 'Intro', author: adaId } },
      'article',
    )
    store = new ContentStore(root, flattenSchema(schemaWith(false), 'content'))
  })

  const expectUnavailable = async (action: Promise<unknown>) => {
    const err = await action.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SchemaUnavailableError)
    expect((err as SchemaUnavailableError).unavailable.schemaRef).toBe('contributorSchema')
  }

  it('refuses to update an existing entry', async () => {
    await expectUnavailable(store.write(people, ada, { format: 'json', data: { name: 'X' } }))
    expect(JSON.parse(await fs.readFile(await findFile('contributor.ada.'), 'utf8'))).toEqual({
      name: 'Ada',
    })
  })

  it('refuses to create one, by name or as the default type', async () => {
    await expectUnavailable(
      store.write(people, unsafeAsSlug('new'), { format: 'json', data: {} }, 'contributor'),
    )
    await expectUnavailable(
      store.write(people, unsafeAsSlug('other'), { format: 'json', data: {} }),
    )
    expect((await fs.readdir(path.join(root, 'content', 'people'))).sort()).toHaveLength(2)
  })

  it('refuses to delete or rename one', async () => {
    await expectUnavailable(store.delete(people, ada))
    await expectUnavailable(store.renameEntry(people, ada, unsafeAsSlug('lovelace')))
    await expectUnavailable(store.assertEntryAvailable(people, ada))
    await findFile('contributor.ada.')
  })

  it('refuses a read for editing, and allows a raw one when asked', async () => {
    await expectUnavailable(store.read(people, ada))
    const raw = await store.read(people, ada, {
      resolveReferences: false,
      allowUnavailableEntryType: true,
    })
    expect(raw.data).toEqual({ name: 'Ada' })
  })

  it('leaves entries of the collection’s other types alone', async () => {
    const grace = unsafeAsSlug('grace')
    await store.assertEntryAvailable(people, grace)
    await store.write(people, grace, { format: 'json', data: { name: 'Grace H' } }, 'staff')
    expect((await store.read(people, grace)).data).toEqual({ name: 'Grace H' })
  })

  it('still resolves a healthy entry’s reference to one', async () => {
    const doc = await store.read(articles, intro)
    expect(doc.data.author).toMatchObject({ id: adaId, name: 'Ada' })
  })

  const findFile = async (prefix: string): Promise<string> => {
    const dir = path.join(root, 'content', 'people')
    const name = (await fs.readdir(dir)).find((file) => file.startsWith(prefix))
    if (!name) throw new Error(`no ${prefix}* file`)
    return path.join(dir, name)
  }
})
