import { flattenSchema } from 'canopycms'
import { ContentStore, resolveSchema } from 'canopycms/server'
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
    relativePath: 'content/authors/alice.json',
    collection: 'authors',
    slug: 'alice',
  })

  await idIndex.add({
    type: 'entry',
    relativePath: 'content/authors/bob.json',
    collection: 'authors',
    slug: 'bob',
  })

  // Get the generated IDs
  const aliceId = idIndex.findByPath('content/authors/alice.json')
  const bobId = idIndex.findByPath('content/authors/bob.json')

  console.log('IDs generated successfully:')
  console.log(`Alice ID: ${aliceId}`)
  console.log(`Bob ID: ${bobId}`)
}

generateIds().catch(console.error)
