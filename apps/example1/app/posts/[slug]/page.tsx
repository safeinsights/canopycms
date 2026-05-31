import React from 'react'
import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { generateContentStaticParams, read } from '../../lib/canopy'

interface Params {
  slug: string
}

export const dynamicParams = true

// Single-segment [slug] route scoped to the posts collection.
export const generateStaticParams = () =>
  generateContentStaticParams({ rootPath: 'content/posts', shape: 'single' })

const PostPage = async ({ params }: { params: Params }) => {
  // Phase-selecting read: build context at build, branch-aware runtime context at request time.
  const { data } = await read<PostContent>({
    entryPath: 'content/posts',
    slug: params.slug,
  })

  return <PostView data={data} />
}

export default PostPage
