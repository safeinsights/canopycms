import { NextResponse } from 'next/server'

// Optional edge protection for /edit and /api/canopycms. This passthrough adds none, and the CMS
// needs none in any auth mode: the API authenticates every request itself, and the editor shows
// the auth provider's sign-in screen to signed-out users. It is the same file for every auth mode,
// so changing CANOPY_AUTH_MODE needs nothing here.
//
// With Clerk you can instead turn signed-out requests away at the edge, before they reach the
// app. On a deployed CMS Lambda that costs two things:
//   - CLERK_SECRET_KEY on the Lambda. clerkMiddleware throws on every request it matches unless
//     it can resolve a secret key (jwtKey doesn't count), which breaks the public-keys-only
//     Lambda that the Security Model in docs/deploying-to-aws.md describes.
//   - One image per Clerk instance. It reads the publishable key inlined at image build
//     (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY), not the one your ClerkProvider receives, unless you
//     pass it an options callback that reads both keys at run time.
// To adopt it anyway, replace this file's contents with:
//
//   import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
//
//   const isProtectedRoute = createRouteMatcher(['/edit(.*)', '/api/canopycms(.*)'])
//
//   // jwtKey avoids a JWKS fetch to api.clerk.com on cold verification -- the prod CMS Lambda
//   // has no internet, and the CLERK_JWT_KEY env var alone is never read.
//   export default clerkMiddleware(
//     async (auth, req) => {
//       if (isProtectedRoute(req)) {
//         await auth.protect()
//       }
//     },
//     { jwtKey: process.env.CLERK_JWT_KEY },
//   )
//
//   export const config = {
//     matcher: ['/edit(.*)', '/api/canopycms(.*)'],
//   }

export default function middleware() {
  return NextResponse.next()
}

export const config = {
  matcher: ['/edit(.*)', '/api/canopycms(.*)'],
}
