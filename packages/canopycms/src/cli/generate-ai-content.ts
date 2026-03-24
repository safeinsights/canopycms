/**
 * CLI command: npx canopycms generate-ai-content
 *
 * Generates static AI-ready content files from CanopyCMS content.
 */

import path from 'node:path'

import { generateAIContentFiles } from '../build/generate-ai-content'
import { getErrorMessage } from '../utils/error'

interface GenerateAIContentCLIOptions {
  projectDir: string
  outputDir?: string
  configPath?: string
}

export async function generateAIContentCLI(options: GenerateAIContentCLIOptions): Promise<void> {
  const { projectDir, outputDir = 'public/ai', configPath } = options

  console.log('\nCanopyCMS generate-ai-content\n')

  // Load adopter's canopycms config
  const canopyConfigPath = path.join(projectDir, 'canopycms.config.ts')
  let canopyConfigModule: Record<string, unknown>
  try {
    canopyConfigModule = (await import(canopyConfigPath)) as Record<string, unknown>
  } catch (err) {
    console.error(`Could not load config from ${canopyConfigPath}`)
    console.error(getErrorMessage(err))
    process.exit(1)
  }

  // Extract the server config (defineCanopyConfig returns { server, client })
  const configExport = canopyConfigModule.default ?? canopyConfigModule.config ?? canopyConfigModule
  const serverConfig =
    typeof configExport === 'object' && configExport !== null && 'server' in configExport
      ? (configExport as { server: unknown }).server
      : configExport

  // Load entry schema registry
  const schemasPath = path.join(projectDir, 'app/schemas.ts')
  let entrySchemaRegistry: Record<string, unknown> = {}
  try {
    const schemasModule = (await import(schemasPath)) as Record<string, unknown>
    entrySchemaRegistry =
      (schemasModule.entrySchemaRegistry as Record<string, unknown>) ?? schemasModule
  } catch {
    console.warn('  No app/schemas.ts found, using empty entry schema registry')
  }

  // Load AI config if specified
  let aiConfig: unknown
  if (configPath) {
    try {
      const aiConfigModule = (await import(path.resolve(configPath))) as Record<string, unknown>
      aiConfig = aiConfigModule.aiContentConfig ?? aiConfigModule.default ?? aiConfigModule.config
    } catch (err) {
      console.error(`Could not load AI config from ${configPath}`)
      console.error(getErrorMessage(err))
      process.exit(1)
    }
  }

  // Validate AI config shape if provided
  if (aiConfig !== undefined && (typeof aiConfig !== 'object' || aiConfig === null)) {
    console.error('Invalid AI content config: expected an object.')
    process.exit(1)
  }

  // Validate loaded config has required shape
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
  console.log(`  Output: ${result.outputDir}\n`)
}
