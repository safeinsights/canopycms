'use client'

import { useCanopyPreview } from 'canopycms/client'

interface HomeData {
  title?: string
  tagline?: string
  published?: boolean
}

export default function HomeView({ initialData = {} }: { initialData?: HomeData }) {
  const { data, fieldProps } = useCanopyPreview<HomeData>({ initialData })

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-4" {...fieldProps('title')}>
        {data?.title ?? 'CanopyCMS Test App'}
      </h1>
      <p className="text-gray-600 mb-8" {...fieldProps('tagline')}>
        {data?.tagline ?? 'This app is for Playwright E2E testing'}
      </p>
      <a href="/edit" className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700">
        Open Editor
      </a>
    </main>
  )
}
