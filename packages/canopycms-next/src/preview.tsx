'use client'

import type { ReactElement, ReactNode } from 'react'
import { useCanopyPreview } from 'canopycms/preview'

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
 * context would put the preview bridge in every page that reads content.
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
