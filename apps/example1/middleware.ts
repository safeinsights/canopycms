import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server'

const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

async function getClerkMiddleware() {
  const { clerkMiddleware, createRouteMatcher } = await import('@clerk/nextjs/server')
  const isProtectedRoute = createRouteMatcher(['/edit(.*)', '/api/canopycms(.*)'])

  return clerkMiddleware(async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect()
    }
  })
}

let clerkHandler: Awaited<ReturnType<typeof getClerkMiddleware>> | null = null

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (authMode !== 'clerk') {
    return NextResponse.next()
  }

  if (!clerkHandler) {
    clerkHandler = await getClerkMiddleware()
  }
  return clerkHandler(req, event)
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}
