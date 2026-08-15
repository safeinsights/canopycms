import {
  createNextCanopyContext,
  type EntryToMetadataOptions,
  type GenerateContentSitemapOptions,
  type GenerateContentStaticParamsOptions,
  type NextCanopyContextResult,
} from 'canopycms-next'
import { stripTrailingSlashes } from 'canopycms/server'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

// Auth plugin selection — fails closed. The dev plugin performs NO real credential
// verification, so it is only ever used when mode is 'dev'. In prod, Clerk is always
// used: if CLERK_SECRET_KEY is missing, createClerkAuthPlugin throws at the first
// authenticated request (construction is cheap, so the zero-editor static build can
// import canopy.ts without the secret), instead of silently falling back to
// unauthenticated dev auth.
const authPlugin =
  config.server.mode === 'prod' || process.env.CANOPY_AUTH_MODE === 'clerk'
    ? createClerkAuthPlugin({ useOrganizationsAsGroups: true })
    : createDevAuthPlugin()

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin,
  entrySchemaRegistry,
})

// Export for server component pages
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Phase-selecting reads: filesystem-direct at build time, branch-aware (ACL-enforced) at request time.
// Recommended for resolving a page by URL/path in a [...slug] / [slug] route — correct in both phases.
export const readByUrlPath: NextCanopyContextResult['readByUrlPath'] = async <T = unknown>(
  urlPath: string,
  options?: { branch?: string; resolveReferences?: boolean },
) => {
  const context = await canopyContextPromise
  return context.readByUrlPath<T>(urlPath, options)
}

export const read: NextCanopyContextResult['read'] = async <T = unknown>(input: {
  entryPath: string
  slug?: string
  branch?: string
  resolveReferences?: boolean
}) => {
  const context = await canopyContextPromise
  return context.read<T>(input)
}

// Enumeration-only static params — no admin build context exposed to page modules.
export const contentStaticParams = async (options?: GenerateContentStaticParamsOptions) => {
  const context = await canopyContextPromise
  return context.generateContentStaticParams(options)
}

// Content sitemap — bound to the build context, so app/sitemap.ts never imports the admin context.
// Enumerates EVERY routable entry type by default; `noindex` entries are dropped through the same
// predicate entryToMetadata uses for robots.
export const contentSitemap = async (options: GenerateContentSitemapOptions) => {
  const context = await canopyContextPromise
  return context.generateContentSitemap(options)
}

// SEO mapping for generateMetadata, bound to this context — see createNextCanopyContext's `seo`
// option. Sharing one binding with contentSitemap above (rather than importing canopycms-next's
// unbound entryToMetadata directly) is what keeps the sitemap's noindex exclusion and this page's
// robots meta reading the SAME field location: set `seo` once above and both agree by
// construction, instead of each call site needing to repeat (and possibly forget) it.
export const entryToMetadata = async (entryData: unknown, options?: EntryToMetadataOptions) => {
  const context = await canopyContextPromise
  return context.entryToMetadata(entryData, options)
}

// The site origin every emitted URL (sitemap, canonical, OG) is resolved against. Inlined at build
// time for a static export, so it must be set in the build environment.
//
// The 'http://localhost:3000' fallback is DEV-ONLY / example-app-only: this app's canopycms.config
// is pinned to `mode: 'dev'` and its own `next build` in CI is a smoke test, not a real deploy, so
// a missing env var here must not fail the build. A real adopter shipping a production site should
// NOT keep a fallback like this — omit it (leave SITE_URL required) so a production build missing
// NEXT_PUBLIC_SITE_URL fails loudly instead of silently baking a localhost sitemap into what ships.
// (`isAbsoluteUrl` in generateContentSitemap will not catch this for you: 'http://localhost:3000'
// is syntactically a perfectly valid absolute URL, just the wrong one.)
//
// stripTrailingSlashes (not a `replace(/\/+$/, '')`) -- that regex is a polynomial-ReDoS shape
// CodeQL flagged in this same package (see static/seo.ts), fixed there with a linear scan that
// canopycms/server exports for exactly this kind of adopter-side origin normalization.
export const SITE_URL = stripTrailingSlashes(
  process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
)

// Advanced escape hatch: the build context bypasses all ACLs (synthetic admin) and throws if used at
// request time on a production server. Prefer readByUrlPath/read/contentStaticParams above.
export const getCanopyForBuild = async () => {
  const context = await canopyContextPromise
  return context.getCanopyForBuild()
}

// Export for API routes
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
