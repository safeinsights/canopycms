import React from 'react'
import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { getCanopy, getCanopyForBuild } from '../../lib/canopy'

interface Params {
  slug: string
}

export const dynamicParams = true

export const generateStaticParams = async (): Promise<Params[]> => {
  const canopy = await getCanopyForBuild()
  const entries = await canopy.listEntries({ rootPath: 'content/posts' })
  return entries.map((entry) => ({ slug: entry.slug }))
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
