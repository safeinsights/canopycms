import { cache, type ReactElement, type ReactNode } from 'react'
import { notFound } from 'next/navigation'
import type { CanopyConfig } from 'canopycms'
import {
  authenticatedAssetBase,
  readAssetBase,
  setServerPreviewAssetBaseGetter,
  type CanopyContext,
} from 'canopycms/server'
import type { CanopyPreviewProps } from './preview'
import type { PreviewRouteProps } from './preview-route'

type ReadEntry = NonNullable<Awaited<ReturnType<CanopyContext['readByUrlPath']>>>

/**
 * The entry a `load` receives. It carries no `meta.physicalPath`, so a loader that returns its
 * whole `entry` cannot send the server's filesystem layout to the browser.
 */
export interface PreviewEntry {
  data: unknown
  /** The entry's slug within its collection, as `listEntries` computes it (`index` for an index entry). */
  slug: ReadEntry['meta']['slug']
  /** The entry's URL path with no query, as `listEntries` computes it (`/docs` for an index entry). */
  urlPath: string
  /** A link back to this entry on the branch read: the percent-encoded URL path plus `?branch=`. */
  path: string
  entryType: string
  entryId?: ReadEntry['meta']['entryId']
}

/** What a `load` receives. */
export interface PreviewLoadContext {
  /** The entry the route is rendering, as read from the requested branch. */
  entry: PreviewEntry
  /** The request-scoped context the entry was read through: authenticated and ACL-checked. */
  canopy: CanopyContext
  /** The `?branch=` the editor named, to pass on to further reads. */
  branch: string | undefined
}

/**
 * A view and the server loader that feeds its `extras` prop. Make one with `previewView`.
 *
 * `load` runs on the server, once per request, after the entry is read and its view found, so an
 * entry type with no view is a 404 without running it. It may throw, or call `notFound()`: either
 * rejects the page rather than rendering.
 *
 * Its result reaches the browser like any RSC prop, so it must be RSC-serializable: plain data
 * or React elements. A server-rendered element such as `<RelatedPosts />` is fine, which lets a
 * view reuse a server component for a section that need not update live. The result is a
 * snapshot of the request and does not follow the editor's live draft; only `data` does.
 */
export interface PreviewViewWithLoader<X> {
  view: (props: CanopyPreviewProps<never, X>) => ReactNode
  load: (ctx: PreviewLoadContext) => X | Promise<X>
}

/**
 * The form `views` holds, with `X` erased. `view` takes `extras?: never`, so a view of any `X`
 * is assignable (its parameter is only wider), and `load` returns `unknown`, so any loader is
 * too. That drops the check that `load`'s result is what `view` expects, which `previewView`
 * restores where each pair is written.
 */
interface ErasedPreviewViewWithLoader {
  view: (props: CanopyPreviewProps<never, never>) => ReactNode
  load: (ctx: PreviewLoadContext) => unknown
}

type PreviewView = (props: CanopyPreviewProps<never>) => ReactNode

/**
 * Pairs a view with its loader, so TypeScript checks that `load`'s result is what the view's
 * `extras` prop expects. A record of views cannot infer a distinct `X` per key, so this identity
 * function infers it for each entry on its own.
 */
export function previewView<X>(entry: PreviewViewWithLoader<X>): PreviewViewWithLoader<X> {
  return entry
}

function hasLoader(
  entry: PreviewView | ErasedPreviewViewWithLoader,
): entry is ErasedPreviewViewWithLoader {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    Object.prototype.hasOwnProperty.call(entry, 'load')
  )
}

export interface CreatePreviewPageOptions {
  /**
   * The view for each entry type the preview route serves, keyed by entry type name, each made by
   * `withCanopyPreview` (`canopycms-next/preview`) in a `'use client'` module, or a
   * `previewView({ view, load })` pair when the view needs more than the entry. An entry whose
   * type has no view is a 404.
   */
  views: Record<string, PreviewView | ErasedPreviewViewWithLoader>
  /**
   * Editor origin to trust, for an editor on another origin. Defaults to the page's own. A
   * request without the viewer's session is a 404, and a `SameSite=Lax` session cookie reaches a
   * framed page only from an editor on the same site, so a cross-site editor previews nothing.
   */
  editorOrigin?: string
}

/**
 * The asset prefix of the request being rendered, set once it is known to be a preview. React's
 * `cache` scopes it to one server request, and outside one it is a fresh, empty object, so a
 * render that is not a preview, or a static build, reads `undefined`.
 */
interface PreviewRequest {
  assetBase?: string
}
let previewRequestScope: (() => PreviewRequest) | undefined
// Created on first use, because React 18 has no `cache`; it must be one instance for every request.
const previewRequest = () => (previewRequestScope ??= cache((): PreviewRequest => ({})))()
const readPreviewRequestAssetBase = (): string | undefined => previewRequest().assetBase

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
 * created. An anonymous request, a missing, unreadable or malformed branch, and a path no entry
 * publishes, are all a 404, so a hidden branch looks the same as a missing one.
 *
 * On a `deployedAs: 'static'` deployment every request is a 404: reads there skip access checks,
 * so the route would show any branch to anyone.
 * @internal Exported for tests.
 */
export function createPreviewPageFor(
  getCanopy: () => Promise<CanopyContext>,
  options: CreatePreviewPageOptions,
  config: Partial<Pick<CanopyConfig, 'deployedAs' | 'basePath'>> = {},
): (props: PreviewPageProps) => Promise<ReactElement> {
  return async function CanopyPreviewPage({ params, searchParams }) {
    if (config.deployedAs === 'static') notFound()
    const [{ path = [] }, query] = await Promise.all([params, searchParams])
    const branch = query.branch
    if (Array.isArray(branch)) notFound()
    const canopy = await getCanopy()
    // Branch ACLs can grant an anonymous user the base branch, and this route is deployed like the
    // editor's routes (canopycms-cdk's `attachTo` `previewPrefix`), outside any site-wide gate.
    if (canopy.user.type === 'anonymous') notFound()
    const result = await canopy.readByUrlPath<never>(`/${path.join('/')}`, { branch })
    if (!result) notFound()
    const { entryType } = result.meta
    const viewEntry = Object.prototype.hasOwnProperty.call(options.views, entryType)
      ? options.views[entryType]
      : undefined
    if (!viewEntry) notFound()
    // From here the response is a preview, so its `/assets/t/` URLs go behind the signed-in route:
    // server components (a `load`, `extras`) through the getter, the view through its prop.
    const previewAssetBase = readAssetBase(authenticatedAssetBase(config.basePath))
    previewRequest().assetBase = previewAssetBase
    setServerPreviewAssetBaseGetter(readPreviewRequestAssetBase)
    if (!hasLoader(viewEntry)) {
      const View: (props: CanopyPreviewProps<never> & PreviewRouteProps) => ReactNode = viewEntry
      return (
        <View
          initialData={result.data}
          editorOrigin={options.editorOrigin}
          previewAssetBase={previewAssetBase}
        />
      )
    }
    const { meta } = result
    const entry: PreviewEntry = {
      data: result.data,
      slug: meta.slug,
      urlPath: meta.urlPath,
      path: result.path,
      entryType: meta.entryType,
      entryId: meta.entryId,
    }
    const extras = await viewEntry.load({ entry, canopy, branch })
    // The record erases `view` to `extras?: never`, so it cannot check `load`'s result against the
    // view; `previewView` does, where a pair is written.
    const View = viewEntry.view as (
      props: CanopyPreviewProps<never, unknown> & PreviewRouteProps,
    ) => ReactNode
    return (
      <View
        initialData={result.data}
        editorOrigin={options.editorOrigin}
        extras={extras}
        previewAssetBase={previewAssetBase}
      />
    )
  }
}
