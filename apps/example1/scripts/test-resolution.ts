/**
 * Test script to verify automatic reference resolution works correctly
 */
import { getCanopy } from '../app/lib/canopy'
import type { PostContent } from '../app/schemas'

async function testResolution() {
  console.log('Testing automatic reference resolution...\n')

  try {
    const canopy = await getCanopy()

    // Read a post - references should be automatically resolved
    const { data } = await canopy.read<PostContent>({
      entryPath: 'content/posts',
      slug: 'hello-world',
    })

    console.log('Post data:')
    console.log('- Title:', data.title)
    console.log('- Author (should be object):', typeof data.author, data.author)

    if (data.author && typeof data.author === 'object') {
      console.log('  - Author name:', data.author.name)
      console.log('  - Author bio:', data.author.bio)
      console.log('\n✅ SUCCESS: Author reference was automatically resolved!')
    } else {
      console.log('\n❌ FAIL: Author is still a string ID, not resolved')
    }

    // Test with resolveReferences: false
    console.log('\n\nTesting with resolveReferences: false...')
    const { data: rawData } = await canopy.read<any>({
      entryPath: 'content/posts',
      slug: 'hello-world',
      resolveReferences: false,
    })

    console.log('- Author (should be string ID):', typeof rawData.author, rawData.author)

    if (typeof rawData.author === 'string') {
      console.log('\n✅ SUCCESS: Opt-out works, author is raw ID')
    } else {
      console.log('\n❌ FAIL: Expected string ID, got object')
    }
  } catch (error) {
    console.error('\n❌ ERROR:', error)
  }
}

testResolution()
