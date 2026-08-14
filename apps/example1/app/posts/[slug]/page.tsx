import React from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import PostView from '../../components/PostView'
import type { PostContent } from '../../schemas'
import { SITE_URL, contentStaticParams, entryToMetadata, readByUrlPath } from '../../lib/canopy'

interface Params {
  slug: string
}

export const dynamicParams = true

// Single-segment [slug] route scoped to the posts collection. Note this is NOT filtered by
// `noindex`: a noindex post must still be built, so its URL resolves for anyone holding the link.
// Only the advertising surfaces (metadata robots, sitemap) suppress it.
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })

// Map the post's SEO group onto Next Metadata. `metaTitle`/`metaDescription` win when set; the
// post's own title is the fallback, and an empty CMS field counts as unset. A post with
// `noindex: true` gets `robots: { index: false }` here AND drops out of app/sitemap.ts — one
// predicate, both surfaces.
export const generateMetadata = async ({
  params,
}: {
  params: Promise<Params>
}): Promise<Metadata> => {
  const { slug } = await params
  const result = await readByUrlPath<PostContent>(`/posts/${slug}`)

  return entryToMetadata(result?.data, {
    path: `/posts/${slug}`,
    siteUrl: SITE_URL,
    siteName: 'CanopyCMS Example',
    fallbackTitle: result?.data.title,
    defaultOgType: 'article',
  })
}

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
