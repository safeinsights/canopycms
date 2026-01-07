import React from 'react'
import DocView from '../../components/DocView'
import type { DocContent } from '../../schemas'
import { getCanopy } from '../../lib/canopy'

interface Params {
  slug?: string[]
}

export const dynamicParams = true

export const generateStaticParams = async (): Promise<Params[]> => {
  return []
}

const DocPage = async ({ params }: { params: Params }) => {
  const canopy = await getCanopy()

  // Build the full path from the slug array
  // The path-based API expects: entryPath = collection path, slug = entry slug
  // e.g., URL: /docs/overview -> entryPath: 'content/docs', slug: 'overview'
  // e.g., URL: /docs/guides/getting-started -> entryPath: 'content/docs/guides', slug: 'getting-started'
  // e.g., URL: /docs/api/v2/authentication -> entryPath: 'content/docs/api/v2', slug: 'authentication'
  const slugParts = params.slug || []

  if (slugParts.length === 0) {
    // Root docs page - list all docs
    return <div>Docs landing page - TODO</div>
  }

  // Last part is always the slug, everything before is the collection path
  const slug = slugParts[slugParts.length - 1]
  const collectionParts = slugParts.slice(0, -1)
  const entryPath =
    collectionParts.length > 0 ? `content/docs/${collectionParts.join('/')}` : 'content/docs'

  const { data } = await canopy.read<DocContent>({
    entryPath,
    slug,
  })

  return <DocView data={data} />
}

export default DocPage
