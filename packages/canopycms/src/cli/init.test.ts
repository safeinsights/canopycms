import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { init, initDeployAws } from './init'

describe('canopycms init', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-init-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates all expected files', async () => {
    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: tmpDir,
    })

    const expectedFiles = [
      'canopycms.config.ts',
      'app/lib/canopy.ts',
      'app/schemas.ts',
      'app/api/canopycms/[...canopycms]/route.ts',
      'app/edit/page.tsx',
    ]

    for (const file of expectedFiles) {
      const filePath = path.join(tmpDir, file)
      const stat = await fs.stat(filePath)
      expect(stat.isFile(), `Expected ${file} to exist`).toBe(true)
    }
  })

  it('generates config with correct mode', async () => {
    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: tmpDir,
    })

    const config = await fs.readFile(path.join(tmpDir, 'canopycms.config.ts'), 'utf-8')
    expect(config).toContain("mode: 'prod-sim'")
    expect(config).toContain('defineCanopyConfig')
  })

  it('generates API route with correct handler pattern', async () => {
    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: tmpDir,
    })

    const route = await fs.readFile(
      path.join(tmpDir, 'app/api/canopycms/[...canopycms]/route.ts'),
      'utf-8',
    )
    expect(route).toContain('getHandler')
    expect(route).toContain('export const GET')
    expect(route).toContain('export const POST')
  })

  it('generates edit page with clerk auth', async () => {
    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: tmpDir,
    })

    const page = await fs.readFile(path.join(tmpDir, 'app/edit/page.tsx'), 'utf-8')
    expect(page).toContain("'use client'")
    expect(page).toContain('useClerkAuthConfig')
    expect(page).toContain('NextCanopyEditorPage')
  })

  it('does not overwrite existing files', async () => {
    const configPath = path.join(tmpDir, 'canopycms.config.ts')
    await fs.writeFile(configPath, 'existing content', 'utf-8')

    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: tmpDir,
    })

    const content = await fs.readFile(configPath, 'utf-8')
    expect(content).toBe('existing content')
  })

  it('updates .gitignore if present', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf-8')

    await init({
      authProvider: 'clerk',
      mode: 'prod-sim',
      projectDir: tmpDir,
    })

    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.canopy-prod-sim/')
  })
})

describe('canopycms init-deploy aws', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-deploy-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates Dockerfile.cms', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir })

    const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile.cms'), 'utf-8')
    expect(dockerfile).toContain('lambda-adapter')
    expect(dockerfile).toContain('CANOPY_BUILD=cms')
    expect(dockerfile).toContain('apt-get install -y git')
  })

  it('creates GitHub Actions workflow', async () => {
    await initDeployAws({ cloud: 'aws', projectDir: tmpDir })

    const workflow = await fs.readFile(
      path.join(tmpDir, '.github/workflows/deploy-cms.yml'),
      'utf-8',
    )
    expect(workflow).toContain('Deploy CMS')
    expect(workflow).toContain('docker build')
  })

  it('does not overwrite existing files', async () => {
    const dockerfilePath = path.join(tmpDir, 'Dockerfile.cms')
    await fs.writeFile(dockerfilePath, 'existing', 'utf-8')

    await initDeployAws({ cloud: 'aws', projectDir: tmpDir })

    const content = await fs.readFile(dockerfilePath, 'utf-8')
    expect(content).toBe('existing')
  })
})
