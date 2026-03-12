import { flattenSchema } from 'canopycms'
import { ContentStore, resolveSchema } from 'canopycms/server'
import { createLogicalPath, createPhysicalPath } from 'canopycms/paths'
import type { EntrySlug } from 'canopycms/paths'
import path from 'path'
import config from '../canopycms.config'

async function generateIds() {
  const root = path.resolve(__dirname, '..')

  // Load schema from .collection.json files
  const { schema } = await resolveSchema(path.join(root, config.server.contentRoot), {})
  const flatSchema = flattenSchema(schema, config.server.contentRoot)
  const store = new ContentStore(root, flatSchema)
  const idIndex = await store.idIndex()

  // Add IDs for alice and bob
  await idIndex.add({
    type: 'entry',
    relativePath: createPhysicalPath('content/authors/alice.json'),
    collection: createLogicalPath('authors'),
    slug: 'alice' as EntrySlug,
  })

  await idIndex.add({
    type: 'entry',
    relativePath: createPhysicalPath('content/authors/bob.json'),
    collection: createLogicalPath('authors'),
    slug: 'bob' as EntrySlug,
  })

  // Get the generated IDs
  const aliceId = idIndex.findByPath('content/authors/alice.json')
  const bobId = idIndex.findByPath('content/authors/bob.json')

  console.log('IDs generated successfully:')
  console.log(`Alice ID: ${aliceId}`)
  console.log(`Bob ID: ${bobId}`)
}

generateIds().catch(console.error)
