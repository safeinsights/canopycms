'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { CanopyEditorPage } from 'canopycms/client'
import type { CanopyClientConfig } from 'canopycms/client'

/**
 * Next.js-specific wrapper for CanopyEditorPage that automatically reads
 * URL search params (branch, entry) using Next.js's useSearchParams hook.
 *
 * @example
 * ```tsx
 * // app/edit/page.tsx
 * 'use client'
 * import { NextCanopyEditorPage } from 'canopycms-next/client'
 * import config from '../../canopycms.config'
 *
 * export default function EditPage() {
 *   const clientConfig = config.client()
 *   const EditorPage = NextCanopyEditorPage(clientConfig)
 *   return <EditorPage />
 * }
 * ```
 */
export const NextCanopyEditorPage = (config: CanopyClientConfig) => {
  const CorePage = CanopyEditorPage(config)

  // Reads URL search params. Next.js 15 requires useSearchParams() consumers to
  // sit under a <Suspense> boundary, otherwise static rendering errors with
  // "useSearchParams() should be wrapped in a suspense boundary". We provide the
  // boundary here so adopters don't have to wrap their /edit page themselves.
  function EditorWithSearchParams() {
    const urlSearchParams = useSearchParams()
    const searchParams = {
      branch: urlSearchParams.get('branch') ?? undefined,
      entry: urlSearchParams.get('entry') ?? undefined,
    }
    return <CorePage searchParams={searchParams} />
  }

  return function NextEditorPage() {
    return (
      <Suspense fallback={null}>
        <EditorWithSearchParams />
      </Suspense>
    )
  }
}
