/**
 * Static build utility for AI content generation.
 *
 * Writes generated AI content to disk as static files.
 * Used during `npm run build` or via the CLI.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { ContentStore } from '../content-store'
import { BranchSchemaCache } from '../branch-schema-cache'
import type { CanopyConfig, FlatSchemaItem } from '../config'
import type { EntrySchemaRegistry } from '../schema/types'
import { generateAIContent } from '../ai/generate'
import { resolveBranchRoot } from '../ai/resolve-branch'
import type { AIContentConfig } from '../ai/types'

export interface GenerateAIContentFilesOptions {
  config: CanopyConfig
  entrySchemaRegistry: EntrySchemaRegistry
  /** Output directory (e.g., 'public/ai') */
  outputDir: string
  aiConfig?: AIContentConfig
  /** @internal Test-only: pre-resolved schema to bypass BranchSchemaCache */
  _testFlatSchema?: FlatSchemaItem[]
}

/**
 * Generate AI content files and write them to disk.
 *
 * @returns Count of files written and the output directory.
 */
export async function generateAIContentFiles(
  options: GenerateAIContentFilesOptions,
): Promise<{ fileCount: number; outputDir: string }> {
  const { config, entrySchemaRegistry, outputDir, aiConfig, _testFlatSchema } = options
  const contentRootName = config.contentRoot || 'content'

  // Resolve branch root
  const branchRoot = await resolveBranchRoot(config)

  // Load schema
  let flatSchema: FlatSchemaItem[]
  if (_testFlatSchema) {
    flatSchema = _testFlatSchema
  } else {
    const schemaCache = new BranchSchemaCache(config.mode)
    const cached = await schemaCache.getSchema(branchRoot, entrySchemaRegistry, contentRootName)
    flatSchema = cached.flatSchema
  }

  // Create store and generate
  const store = new ContentStore(branchRoot, flatSchema)
  const result = await generateAIContent({
    store,
    flatSchema,
    contentRoot: contentRootName,
    config: aiConfig,
  })

  // Write files to disk
  const absoluteOutputDir = path.resolve(outputDir) + path.sep
  let fileCount = 0

  for (const [filePath, content] of result.files) {
    const absolutePath = path.resolve(path.join(absoluteOutputDir, filePath))
    // Security: prevent path traversal in output (e.g., malicious bundle names)
    if (!absolutePath.startsWith(absoluteOutputDir)) {
      throw new Error(`Path traversal detected in AI content output: ${filePath}`)
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf-8')
    fileCount++
  }

  return { fileCount, outputDir: absoluteOutputDir }
}
