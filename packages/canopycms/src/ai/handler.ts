/**
 * Next.js route handler for AI content.
 *
 * Creates a lightweight, read-only handler that serves AI-ready markdown.
 * Does NOT require authentication or the editor API — only needs ContentStore.
 *
 * Mount as a Next.js catch-all route:
 * ```ts
 * // app/ai/[...path]/route.ts
 * export const GET = createAIContentHandler({ config, entrySchemaRegistry })
 * ```
 */

import { ContentStore } from '../content-store'
import { BranchSchemaCache } from '../branch-schema-cache'
import { loadBranchContext } from '../branch-metadata'
import type { CanopyConfig, FlatSchemaItem } from '../config'
import type { EntrySchemaRegistry } from '../schema/types'
import { generateAIContent, type GenerateResult } from './generate'
import type { AIContentConfig } from './types'

export interface AIContentHandlerOptions {
  config: CanopyConfig
  entrySchemaRegistry: EntrySchemaRegistry
  aiConfig?: AIContentConfig
  /** @internal Test-only: pre-resolved schema to bypass BranchSchemaCache */
  _testFlatSchema?: FlatSchemaItem[]
}

/**
 * Create a Next.js GET handler for serving AI content.
 *
 * Returns a function compatible with Next.js route handlers.
 * Generates content lazily on first request and caches the result.
 * In dev mode, regenerates on every request.
 */
export function createAIContentHandler(
  options: AIContentHandlerOptions,
): (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response> {
  const { config, entrySchemaRegistry, aiConfig, _testFlatSchema } = options
  const schemaCache = new BranchSchemaCache(config.mode)
  let cachedResult: GenerateResult | null = null

  const generate = async (): Promise<GenerateResult> => {
    // In dev mode, always regenerate (content changes without deploys)
    if (config.mode === 'dev') {
      if (!_testFlatSchema) {
        await schemaCache.clearAll()
      }
      cachedResult = null
    }

    if (cachedResult) return cachedResult

    // Resolve branch root
    const branchRoot = await resolveBranchRoot(config)
    const contentRootName = config.contentRoot || 'content'

    // Load schema (use test override if provided)
    const flatSchema =
      _testFlatSchema ??
      (await schemaCache.getSchema(branchRoot, entrySchemaRegistry, contentRootName)).flatSchema

    // Create store and generate
    const store = new ContentStore(branchRoot, flatSchema)
    const result = await generateAIContent({
      store,
      flatSchema,
      contentRoot: contentRootName,
      config: aiConfig,
    })

    cachedResult = result
    return result
  }

  return async (_req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> => {
    try {
      const { path: pathSegments } = await ctx.params
      const result = await generate()

      // Join path segments to get the file key
      const requestPath = pathSegments.join('/')

      // Check for manifest
      if (requestPath === 'manifest.json') {
        return new Response(result.files.get('manifest.json'), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': config.mode === 'dev' ? 'no-cache' : 'public, max-age=60',
          },
        })
      }

      // Check for generated file
      const content = result.files.get(requestPath)
      if (content) {
        return new Response(content, {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': config.mode === 'dev' ? 'no-cache' : 'public, max-age=60',
          },
        })
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error'
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
}

/**
 * Resolve the branch root directory for reading content.
 *
 * - Dev mode: current working directory (content is in the checkout)
 * - Prod/prod-sim: load the default base branch context
 */
async function resolveBranchRoot(config: CanopyConfig): Promise<string> {
  if (config.mode === 'dev') {
    return process.cwd()
  }

  const baseBranch = config.defaultBaseBranch ?? 'main'
  const context = await loadBranchContext({
    branchName: baseBranch,
    mode: config.mode,
  })

  if (!context) {
    throw new Error(
      `AI content handler: could not load branch context for "${baseBranch}". ` +
        'Ensure the branch exists and has been initialized.',
    )
  }

  return context.branchRoot
}
