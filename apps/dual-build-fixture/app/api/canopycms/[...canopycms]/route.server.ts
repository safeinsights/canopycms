import { getHandler } from '../../../lib/canopy'
import type { NextRequest } from 'next/server'

// CMS-only catch-all API route -- `.server.ts` so the static export build
// never sees it (the whole point of this fixture is proving that).
const handler = getHandler()

type RouteContext = { params: Promise<Record<string, string | string[]>> }

export const GET = async (req: NextRequest, ctx: RouteContext) => (await handler)(req, ctx)
export const POST = async (req: NextRequest, ctx: RouteContext) => (await handler)(req, ctx)
export const PUT = async (req: NextRequest, ctx: RouteContext) => (await handler)(req, ctx)
export const PATCH = async (req: NextRequest, ctx: RouteContext) => (await handler)(req, ctx)
export const DELETE = async (req: NextRequest, ctx: RouteContext) => (await handler)(req, ctx)
