import type { MetadataRoute } from 'next'
import { SITE_URL, contentSitemap } from './lib/canopy'

// Required for a static export (`output: 'export'`): metadata routes must opt into static
// generation explicitly.
export const dynamic = 'force-static'

/**
 * The content sitemap.
 *
 * Every routable entry type is included by default — there is no list of "sitemap-able" types to
 * keep in sync, which is the point: a hand-rolled sitemap built from a remembered list of entry
 * types silently omits whichever type nobody added, and nothing warns.
 *
 * `noindex` entries are dropped automatically, through the same predicate that puts
 * `robots: { index: false }` on the page itself (see app/posts/[slug]/page.tsx).
 *
 * **There is no entry here for the home page, and that is the interesting part.** Home is modelled
 * as a root `index` entry (`content/home.index.<id>.json`), so its `urlPath` is already `/` — the
 * URL app/page.tsx serves. It is advertised like any other entry, carrying its own `lastModified`.
 * This file used to exclude it by entry type and then add `/` back by hand through `extraUrls`,
 * because home's `urlPath` was `/home` while the route served `/`. Both lines existed only to
 * reconcile that mismatch, and modelling the entry correctly removed the mismatch instead.
 *
 * That ordering generalises, and it is the recommendation: **model the entry so its natural
 * `urlPath` is the URL you serve.** If you genuinely cannot — a URL fixed by history you can't
 * change, or a route prefix that deliberately differs from your content layout — reach for
 * `pathFor`, which reroutes the entry while keeping it in the walk (so the `noindex` gate and the
 * `lastModified` default still apply). Keep `extraUrls` for URLs with no entry behind them at all.
 *
 * The exclusions that remain are the shape an omission SHOULD have — explicit, and each with a
 * reason. Both are cases where an entry's `urlPath` is not a URL this app serves:
 *
 *   - `author` entries are referenced BY posts and have no page of their own.
 *   - `snippet` entries are content-for-embedding (see the "Shared / Referenced Blocks" recipe):
 *     they are addressed by reference from within a block, never visited directly, and this app
 *     has no route serving their `urlPath` shape. This is the mirror image of the failure this
 *     helper exists to prevent — instead of *forgetting* a type that should be listed, an entry
 *     type that the schema allows but no route serves would otherwise be advertised and 404. The
 *     tell: a type only counts as routable in practice if some route in `app/` actually serves
 *     its `urlPath` shape, not just because the schema doesn't mark it unaddressable.
 */
export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return contentSitemap({
    siteUrl: SITE_URL,
    // This app does not set `trailingSlash` in next.config.mjs, so URLs are emitted without one.
    // Set `trailingSlash: true` here if your next config does — CanopyCMS cannot see that file,
    // and a mismatch advertises URLs that redirect.
    exclude: (entry) => entry.entryType === 'author' || entry.entryType === 'snippet',
    // lastModified defaults to the entry's `updatedAt`, which is the file's mtime: on a fresh CI
    // clone that is checkout time, not edit time — which is exactly what you will see if you run
    // `next build` here. Pass a `lastModified` callback returning a real content date if you have
    // one, or `undefined` to omit <lastmod> rather than assert a date you cannot stand behind.
  })
}
