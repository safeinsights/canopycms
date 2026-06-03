import React from 'react'
import { notFound } from 'next/navigation'
import DocView from '../../components/DocView'
import type { DocContent } from '../../schemas'
import { contentStaticParams, readByUrlPath } from '../../lib/canopy'

interface Params {
  slug?: string[]
}

export const dynamicParams = true

// Catch-all nested under /docs: basePath makes the params relative to the route base.
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/docs', basePath: '/docs' })

const DocPage = async ({ params }: { params: Promise<Params> }) => {
  // Next.js 15: route params are async and must be awaited.
  const { slug } = await params
  const slugParts = slug || []

  if (slugParts.length === 0) {
    return <div>Docs landing page - TODO</div>
  }

  // Phase-selecting read: build context at build, branch-aware runtime context at request time.
  const urlPath = `/docs/${slugParts.join('/')}`
  const result = await readByUrlPath<DocContent>(urlPath)

  if (!result) return notFound()

  return <DocView data={result.data} />
}

export default DocPage
