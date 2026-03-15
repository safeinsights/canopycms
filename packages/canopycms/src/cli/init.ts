#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canopyCmsConfig,
  canopyContextClerk,
  schemasTemplate,
  apiRoute,
  editPageClerk,
  dockerfileCms,
  githubWorkflowCms,
} from './templates'

interface InitOptions {
  authProvider: 'clerk'
  mode: 'prod-sim' | 'dev'
  projectDir: string
}

interface InitDeployOptions {
  cloud: 'aws'
  projectDir: string
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function writeIfNotExists(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) {
    console.log(`  skip: ${path.relative(process.cwd(), filePath)} (already exists)`)
    return false
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  console.log(`  created: ${path.relative(process.cwd(), filePath)}`)
  return true
}

/**
 * Framework integration: generates the files needed to add CanopyCMS
 * editing to a Next.js app. Cloud-agnostic.
 */
export async function init(options: InitOptions): Promise<void> {
  const { projectDir, mode } = options

  console.log('\nCanopyCMS init\n')

  // Generate files
  await writeIfNotExists(
    path.join(projectDir, 'canopycms.config.ts'),
    canopyCmsConfig({ mode }),
  )
  await writeIfNotExists(
    path.join(projectDir, 'app/lib/canopy.ts'),
    canopyContextClerk(),
  )
  await writeIfNotExists(
    path.join(projectDir, 'app/schemas.ts'),
    schemasTemplate(),
  )
  await writeIfNotExists(
    path.join(projectDir, 'app/api/canopycms/[...canopycms]/route.ts'),
    apiRoute(),
  )
  await writeIfNotExists(
    path.join(projectDir, 'app/edit/page.tsx'),
    editPageClerk(),
  )

  // Update .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore')
  if (await fileExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (!content.includes('.canopy-prod-sim')) {
      await fs.appendFile(gitignorePath, '\n# CanopyCMS\n.canopy-prod-sim/\n.canopy-dev/\n')
      console.log('  updated: .gitignore')
    }
  }

  console.log(`
Next steps:
  1. Install dependencies:
     npm install canopycms canopycms-next canopycms-auth-clerk canopycms-auth-dev

  2. Add transpilePackages to next.config.ts:
     transpilePackages: ['canopycms']

  3. Customize app/schemas.ts with your content schema

  4. Run: npm run dev
  5. Visit: http://localhost:3000/edit
`)
}

/**
 * Cloud deployment artifacts: generates AWS-specific files
 * (Dockerfile, CI workflow).
 */
export async function initDeployAws(options: InitDeployOptions): Promise<void> {
  const { projectDir } = options

  console.log('\nCanopyCMS init-deploy aws\n')

  await writeIfNotExists(
    path.join(projectDir, 'Dockerfile.cms'),
    dockerfileCms(),
  )
  await writeIfNotExists(
    path.join(projectDir, '.github/workflows/deploy-cms.yml'),
    githubWorkflowCms(),
  )

  // Check if next.config already has CANOPY_BUILD support
  const nextConfigPath = path.join(projectDir, 'next.config.ts')
  const nextConfigMjsPath = path.join(projectDir, 'next.config.mjs')
  const configPath = (await fileExists(nextConfigPath)) ? nextConfigPath : (await fileExists(nextConfigMjsPath)) ? nextConfigMjsPath : null

  if (configPath) {
    const content = await fs.readFile(configPath, 'utf-8')
    if (!content.includes('CANOPY_BUILD')) {
      console.log(`
  NOTE: Add dual build support to ${path.basename(configPath)}:

    output: process.env.CANOPY_BUILD === 'cms' ? 'standalone' : 'export',
`)
    }
  }

  console.log(`
  CDK constructs are available via the canopycms-cdk package.
  See the deployment plan for CDK stack setup.
`)
}

// CLI entrypoint
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'init') {
    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: process.cwd(),
    })
  } else if (command === 'init-deploy') {
    const cloud = args[1]
    if (cloud !== 'aws') {
      console.error('Usage: canopycms init-deploy aws')
      console.error('Only "aws" is currently supported.')
      process.exit(1)
    }
    await initDeployAws({
      cloud: 'aws',
      projectDir: process.cwd(),
    })
  } else {
    console.log('CanopyCMS CLI')
    console.log('')
    console.log('Commands:')
    console.log('  init              Add CanopyCMS to a Next.js app')
    console.log('  init-deploy aws   Generate AWS deployment artifacts')
    process.exit(0)
  }
}

// Only run when executed directly as a CLI, not when imported in tests
const __filename = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] === __filename

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
