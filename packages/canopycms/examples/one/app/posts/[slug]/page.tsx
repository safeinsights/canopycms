import React from 'react'
import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { getCanopy } from '../../lib/canopy'

interface Params {
  slug: string
}

export const dynamicParams = true

export const generateStaticParams = async (): Promise<Params[]> => {
  return []
}

const PostPage = async ({ params }: { params: Params }) => {
  const canopy = await getCanopy()

  const { data } = await canopy.read<PostContent>({
    entryPath: 'content/posts',
    slug: params.slug,
  })

  return <PostView data={data} />
}

export default PostPage
