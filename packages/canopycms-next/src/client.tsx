'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { CanopyEditorPage } from 'canopycms/client'
import type { CanopyClientConfig, CustomFieldRenderers } from 'canopycms/client'

/**
 * Next.js-specific wrapper for CanopyEditorPage that automatically reads
 * URL search params (branch, entry) using Next.js's useSearchParams hook.
 *
 * @param customRenderers Optional per-field-type render overrides, forwarded
 * to `CanopyEditorPage`. Forwarded rather than dropped for a specific reason:
 * Next is the primary target, so this wrapper is the entrypoint adopters
 * actually import (it is what the README's Quick Start scaffolds). Accepting
 * the argument only on the core `CanopyEditorPage` made the extension point
 * unreachable from the path every adopter uses, which is an extension point
 * in name only.
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
