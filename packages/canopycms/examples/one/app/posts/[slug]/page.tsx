import React from 'react'

import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { createContentReader } from 'canopycms/server'
import { ANONYMOUS_USER } from 'canopycms'
import config from '../../../canopycms.config'

const contentReader = createContentReader({ config: config.server })

interface Params {
  slug: string
}

export const dynamicParams = true

export const generateStaticParams = async (): Promise<Params[]> => {
  return []
}

const PostPage = async ({
  params,
  searchParams,
}: {
  params: Params
  searchParams?: { branch?: string }
}) => {
  const { data } = await contentReader.read<PostContent>({
    entryPath: 'content/posts',
    slug: params.slug,
    branch: searchParams?.branch,
    user: ANONYMOUS_USER,
  })
  return <PostView data={data} />
}

export default PostPage
