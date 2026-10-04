import { ClerkProvider } from '@clerk/nextjs'

// Empirical fixture for adopter request #40: a static export of the public
// site plus a standalone editor build needs a `<ClerkProvider>` somewhere
// the static build never resolves. This proves (via dual-build.test.ts's
// "@clerk/nextjs" assertions) that Next resolves `layout.server.tsx` as a
// real layout under withCanopy()'s CMS pageExtensions (`server.tsx` added),
// scoped to the /edit subtree only -- and that the static build, which gets
// `static.tsx` in pageExtensions INSTEAD of `server.tsx` (additive, not a
// subtraction from a shared list -- see with-canopy.ts), never resolves this
// file and therefore never reaches `@clerk/nextjs` at all. See
// docs/deploying-to-aws.md's Dual Build Support section.
//
// The publishable key comes from a plain run-time variable when one is set:
// the shape that section documents as "One image for every Clerk tier". The
// `dynamic` export is what makes that a per-request read. Without it, Next
// prerenders /edit at `next build` and bakes in whatever the variable held
// then. It has to live here, in a server component: page.server.tsx is a
// 'use client' module, and a `dynamic` export there did not stop the
// prerender (measured on Next 15.5.21). dual-build.test.ts builds without the
// variable, serves with it, and asserts the served /edit carries it.
export const dynamic = 'force-dynamic'

// The fallback is a syntactically valid but fake publishable key (base64 of
// `canopycms-dual-build-fixture.clerk.accounts.dev$`) -- @clerk/nextjs's
// `parsePublishableKey` only checks that shape, so this never talks to
// Clerk's real backend. Rendering this layout (and the /edit route beneath
// it) must not require live Clerk credentials.
const FIXTURE_PUBLISHABLE_KEY =
  'pk_test_Y2Fub3B5Y21zLWR1YWwtYnVpbGQtZml4dHVyZS5jbGVyay5hY2NvdW50cy5kZXYk'

export default function EditLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={process.env.FIXTURE_CLERK_PUBLISHABLE_KEY ?? FIXTURE_PUBLISHABLE_KEY}
    >
      {children}
    </ClerkProvider>
  )
}
