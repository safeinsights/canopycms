import React from 'react'
import { notFound } from 'next/navigation'
import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { contentStaticParams, readByUrlPath } from '../../lib/canopy'

interface Params {
  slug: string
}

export const dynamicParams = true

// Single-segment [slug] route scoped to the posts collection.
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })

const PostPage = async ({ params }: { params: Promise<Params> }) => {
  // Next.js 15: route params are async and must be awaited.
  const { slug } = await params
  // Phase-selecting read: build context at build, branch-aware runtime context at request time.
  // Null-safe — returns null (→ 404) for unknown/non-entry slugs rather than throwing.
  const result = await readByUrlPath<PostContent>(`/posts/${slug}`)

  if (!result) return notFound()

  return <PostView data={result.data} />
}

export default PostPage
