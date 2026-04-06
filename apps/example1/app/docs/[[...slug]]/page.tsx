import React from 'react'
import { notFound } from 'next/navigation'
import DocView from '../../components/DocView'
import type { DocContent } from '../../schemas'
import { getCanopy, getCanopyForBuild } from '../../lib/canopy'

interface Params {
  slug?: string[]
}

export const dynamicParams = true

export const generateStaticParams = async (): Promise<Params[]> => {
  const canopy = await getCanopyForBuild()
  const entries = await canopy.listEntries({ rootPath: 'content/docs' })
  return entries.map((entry) => ({ slug: entry.pathSegments }))
}

const DocPage = async ({ params }: { params: Params }) => {
  const slugParts = params.slug || []

  if (slugParts.length === 0) {
    return <div>Docs landing page - TODO</div>
  }

  const canopy = await getCanopy()
  const urlPath = `/docs/${slugParts.join('/')}`
  const result = await canopy.readByUrlPath<DocContent>(urlPath)

  if (!result) return notFound()

  return <DocView data={result.data} />
}

export default DocPage
