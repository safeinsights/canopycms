import { getHandler } from '../../../lib/canopy'
import type { NextRequest } from 'next/server'

const handler = getHandler()

export const GET = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const POST = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const PUT = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const DELETE = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
