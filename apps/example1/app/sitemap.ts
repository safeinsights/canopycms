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
 * The two exclusions below are the shape an omission SHOULD have — explicit, and each with a
 * reason. Both are cases where an entry's `urlPath` is not a URL this app serves:
 *
 *   - `author` entries are referenced BY posts and have no page of their own.
 *   - the `home` singleton lives at `content/home`, so its `urlPath` is `/home`, but app/page.tsx
 *     serves it at `/`. Advertising `/home` would advertise a 404, so it is excluded and `/` is
 *     added below via `extraUrls`. (Modelling home as a root `index` entry instead would give it
 *     `urlPath: '/'` and remove the need for both lines.)
 */
export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return contentSitemap({
    siteUrl: SITE_URL,
    // This app does not set `trailingSlash` in next.config.mjs, so URLs are emitted without one.
    // Set `trailingSlash: true` here if your next config does — CanopyCMS cannot see that file,
    // and a mismatch advertises URLs that redirect.
    exclude: (entry) => entry.entryType === 'author' || entry.entryType === 'home',
    extraUrls: [{ path: '/', priority: 1 }],
    // lastModified defaults to the entry's `updatedAt`, which is the file's mtime: on a fresh CI
    // clone that is checkout time, not edit time — which is exactly what you will see if you run
    // `next build` here. Pass a `lastModified` callback returning a real content date if you have
    // one, or `undefined` to omit <lastmod> rather than assert a date you cannot stand behind.
  })
}
