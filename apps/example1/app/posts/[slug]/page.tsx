import React from 'react'
import { generateContentStaticParams } from 'canopycms-next'
import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { getCanopy, getCanopyForBuild } from '../../lib/canopy'

interface Params {
  slug: string
}

export const dynamicParams = true

// Single-segment [slug] route scoped to the posts collection.
export const generateStaticParams = () =>
  generateContentStaticParams(getCanopyForBuild, { rootPath: 'content/posts', shape: 'single' })

const PostPage = async ({ params }: { params: Params }) => {
  const canopy = await getCanopy()

  const { data } = await canopy.read<PostContent>({
    entryPath: 'content/posts',
    slug: params.slug,
  })

  return <PostView data={data} />
}

export default PostPage
