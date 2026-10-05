import type { ReactElement } from 'react'
import { notFound } from 'next/navigation'
import type { CanopyConfig } from 'canopycms'
import type { CanopyContext } from 'canopycms/server'
import { CanopyPreviewView, type CanopyPreviewViewComponent } from './client'

export interface CreatePreviewPageOptions {
  /**
   * The view for each entry type the preview route serves, keyed by entry type name. Each is a
   * `'use client'` component; it receives the live draft as `data`. An entry whose type has no
   * view is a 404.
   */
  views: Record<string, CanopyPreviewViewComponent<never>>
  /** Editor origin to trust, for an editor on another origin. Defaults to the page's own. */
  editorOrigin?: string
}

/** The props Next passes a `[[...path]]` page. */
export interface PreviewPageProps {
  params: Promise<{ path?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * The page for a `[[...path]]` route mounted at `editor.previewPrefix`: it reads the entry at
 * the route's path from the `?branch=` the editor names and renders its view.
 *
 * The read goes through the request-scoped `getCanopy()`, never the build context: it is
 * authenticated and ACL-checked, and a branch other than the active one is only loaded, never
 * created. A missing, unreadable or malformed branch, and a path no entry publishes, are all a
 * 404, so a hidden branch looks the same as a missing one.
 *
 * On a `deployedAs: 'static'` deployment every request is a 404: reads there skip access checks,
 * so the route would show any branch to anyone.
 * @internal Exported for tests.
 */
export function createPreviewPageFor(
  getCanopy: () => Promise<CanopyContext>,
  options: CreatePreviewPageOptions,
  deployedAs: CanopyConfig['deployedAs'] = 'server',
): (props: PreviewPageProps) => Promise<ReactElement> {
  return async function CanopyPreviewPage({ params, searchParams }) {
    if (deployedAs === 'static') notFound()
    const [{ path = [] }, query] = await Promise.all([params, searchParams])
    const branch = query.branch
    if (Array.isArray(branch)) notFound()
    const canopy = await getCanopy()
    const result = await canopy.readByUrlPath<never>(`/${path.join('/')}`, { branch })
    if (!result) notFound()
    const { entryType } = result.meta
    const View = Object.prototype.hasOwnProperty.call(options.views, entryType)
      ? options.views[entryType]
      : undefined
    if (!View) notFound()
    return (
      <CanopyPreviewView
        view={View}
        initialData={result.data}
        editorOrigin={options.editorOrigin}
      />
    )
  }
}
