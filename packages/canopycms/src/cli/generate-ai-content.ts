/**
 * CLI command: npx canopycms generate-ai-content
 *
 * Generates static AI-ready content files from CanopyCMS content.
 */

import path from 'node:path'

import { generateAIContentFiles } from '../build/generate-ai-content'
import { getErrorMessage } from '../utils/error'
import {
  importSiteEntrySchemaRegistry,
  importSiteModule,
  importSiteServerConfig,
} from './site-config'

interface GenerateAIContentCLIOptions {
  projectDir: string
  outputDir?: string
  configPath?: string
  appDir?: string
}

export async function generateAIContentCLI(options: GenerateAIContentCLIOptions): Promise<void> {
  const { projectDir, outputDir = 'public/ai', configPath, appDir = 'app' } = options

  console.log('\nCanopyCMS generate-ai-content\n')

  let serverConfig: unknown
  try {
    serverConfig = (await importSiteServerConfig(projectDir)).server
  } catch (err) {
    console.error(`Could not load config from ${path.join(projectDir, 'canopycms.config.ts')}`)
    console.error(getErrorMessage(err))
    process.exit(1)
  }

  let entrySchemaRegistry: Record<string, unknown> = {}
  try {
    entrySchemaRegistry = (await importSiteEntrySchemaRegistry(projectDir, appDir)).registry
  } catch {
    console.warn(`  No ${appDir}/schemas.ts found, using empty entry schema registry`)
  }

  let aiConfig: unknown
  if (configPath) {
    try {
      const aiConfigModule = await importSiteModule(path.resolve(configPath))
      aiConfig = aiConfigModule.aiContentConfig ?? aiConfigModule.default ?? aiConfigModule.config
    } catch (err) {
      console.error(`Could not load AI config from ${configPath}`)
      console.error(getErrorMessage(err))
      process.exit(1)
    }
  }

  if (aiConfig !== undefined && (typeof aiConfig !== 'object' || aiConfig === null)) {
    console.error('Invalid AI content config: expected an object.')
    process.exit(1)
  }

  if (
    !serverConfig ||
    typeof serverConfig !== 'object' ||
    !('mode' in serverConfig) ||
    !('contentRoot' in serverConfig)
  ) {
    console.error(
      'Invalid CanopyCMS config: expected an object with mode and contentRoot properties.',
    )
    console.error('Make sure canopycms.config.ts uses defineCanopyConfig().')
    process.exit(1)
  }

  const resolvedOutput = path.resolve(projectDir, outputDir)
  console.log(`  Output: ${resolvedOutput}`)
  console.log(`  Mode: ${(serverConfig as { mode?: string }).mode ?? 'dev'}`)

  const result = await generateAIContentFiles({
    config: serverConfig as Parameters<typeof generateAIContentFiles>[0]['config'],
    entrySchemaRegistry: entrySchemaRegistry as Parameters<
      typeof generateAIContentFiles
    >[0]['entrySchemaRegistry'],
    outputDir: resolvedOutput,
    aiConfig: aiConfig as Parameters<typeof generateAIContentFiles>[0]['aiConfig'],
  })

  console.log(`\n  Generated ${result.fileCount} files`)
  if (result.removedCount > 0) {
    // Logged separately: a removal is the visible half of a rename or re-modelled
    // entry, and silence here would let stale files accumulate unnoticed.
    console.log(`  Removed ${result.removedCount} stale files from the previous run`)
  }
  console.log(`  Output: ${result.outputDir}\n`)
}
