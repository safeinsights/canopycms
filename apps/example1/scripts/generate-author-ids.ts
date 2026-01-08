import { ContentStore } from 'canopycms'
import path from 'path'
import config from '../canopycms.config'

async function generateIds() {
  const root = path.resolve(__dirname, '..')
  const store = new ContentStore(root, config.server)
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
