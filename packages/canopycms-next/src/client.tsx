'use client'

import { Suspense, type ReactElement, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { CanopyEditorPage, useCanopyPreview } from 'canopycms/client'
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

/** What a preview view renders from: the editor's live draft, plus `useCanopyPreview`'s helpers. */
export type CanopyPreviewViewProps<T> = ReturnType<typeof useCanopyPreview<T>>

/** The props of a view wrapped by `withCanopyPreview`. */
export interface CanopyPreviewProps<T, X = undefined> {
  /** The saved entry data, rendered until the editor sends a draft. */
  initialData: T
  /** Editor origin to trust, for an editor on another origin. Defaults to this page's own. */
  editorOrigin?: string
  /**
   * What the route's `load` returned (see `previewView`), handed to the view untouched as its
   * `extras` prop. Absent on a public page and for a view with no loader.
   */
  extras?: X
}

/**
 * Wraps a view so it renders the editor's live draft of `initialData`, through `useCanopyPreview`;
 * outside an editor frame it renders `initialData` unchanged.
 *
 * Call it in your own `'use client'` module and pass the result to `createPreviewPage`'s `views`,
 * or render it on a public page. The wrapping lives in your module, not in `createPreviewPage`,
 * because Next ships every client module a page's server code imports: one imported by the
 * context would put the editor in every page that reads content.
 *
 * The returned type is a call signature rather than `ComponentType`, whose `propTypes` would make
 * a view for one content type unassignable to a map of views for many. It returns `ReactElement`,
 * which JSX accepts on every supported TypeScript, where `ReactNode` needs `JSX.ElementType`.
 */
export function withCanopyPreview<T, X = undefined>(
  View: (props: CanopyPreviewViewProps<T> & { extras: X | undefined }) => ReactNode,
): (props: CanopyPreviewProps<T, X>) => ReactElement {
  return function CanopyPreview({ initialData, editorOrigin, extras }: CanopyPreviewProps<T, X>) {
    const preview = useCanopyPreview<T>({ initialData, editorOrigin })
    // `extras` is a prop of its own, never spread into the hook's result, so it cannot shadow
    // `data` or `fieldProps`.
    return <View {...preview} extras={extras} />
  }
}
