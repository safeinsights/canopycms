'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { CanopyEditorPage } from 'canopycms/client'
import type { CanopyClientConfig, CustomFieldRenderers } from 'canopycms/client'

/**
 * Next.js-specific wrapper for CanopyEditorPage that automatically reads
 * URL search params (branch, entry) using Next.js's useSearchParams hook.
 *
 * @param customRenderers Optional per-field-type render overrides, forwarded to
 * `CanopyEditorPage`. Forwarded (not dropped) because Next is the primary target: this wrapper
 * is the entrypoint every adopter imports (the README's Quick Start scaffolds it), so accepting
 * the argument only on core `CanopyEditorPage` would make the extension point unreachable from
 * the path adopters actually use.
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
export const NextCanopyEditorPage = (
  config: CanopyClientConfig,
  customRenderers?: CustomFieldRenderers,
) => {
  const CorePage = CanopyEditorPage(config, customRenderers)

  // Next.js 15 requires useSearchParams() consumers to sit under a <Suspense> boundary, or static
  // rendering errors with "useSearchParams() should be wrapped in a suspense boundary" — provided
  // here so adopters don't have to wrap their /edit page themselves.
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
