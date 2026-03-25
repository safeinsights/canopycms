/**
 * File templates for `canopycms init` and `canopycms init-deploy aws`.
 * Reads .template files from the template-files/ directory for readability.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.join(__dirname, 'template-files')

async function readTemplate(name: string): Promise<string> {
  return fs.readFile(path.join(TEMPLATES_DIR, name), 'utf-8')
}

export async function canopyCmsConfig(options: { mode: string }): Promise<string> {
  const template = await readTemplate('canopycms.config.ts.template')
  return template.replace('{{MODE}}', options.mode)
}

export async function canopyContext(options: {
  configImport: string
  authProvider: 'clerk' | 'dev'
}): Promise<string> {
  const template = await readTemplate('canopy.ts.template')
  const isClerk = options.authProvider === 'clerk'
  const authImports = isClerk
    ? `import { createClerkAuthPlugin, createClerkJwtVerifier } from 'canopycms-auth-clerk'`
    : `import { createDevAuthPlugin, createDevTokenVerifier } from 'canopycms-auth-dev'`
  const authTokenVerifier = isClerk
    ? `createClerkJwtVerifier({ jwtKey: process.env.CLERK_JWT_KEY ?? '' })`
    : `createDevTokenVerifier()`
  const authDirectPlugin = isClerk
    ? `createClerkAuthPlugin({ useOrganizationsAsGroups: true })`
    : `createDevAuthPlugin()`
  return template
    .replace('{{CONFIG_IMPORT}}', options.configImport)
    .replace('{{AUTH_IMPORTS}}', authImports)
    .replace('{{AUTH_TOKEN_VERIFIER}}', authTokenVerifier)
    .replace('{{AUTH_DIRECT_PLUGIN}}', authDirectPlugin)
}

export async function schemasTemplate(): Promise<string> {
  return readTemplate('schemas.ts.template')
}

export async function apiRoute(options: { canopyImport: string }): Promise<string> {
  const template = await readTemplate('route.ts.template')
  return template.replace('{{CANOPY_IMPORT}}', options.canopyImport)
}

export async function editPage(options: { configImport: string }): Promise<string> {
  const template = await readTemplate('edit-page.tsx.template')
  return template.replace('{{CONFIG_IMPORT}}', options.configImport)
}

export async function aiConfig(): Promise<string> {
  return readTemplate('ai-config.ts.template')
}

export async function aiRoute(options: { configImport: string }): Promise<string> {
  const template = await readTemplate('ai-route.ts.template')
  return template.replace('{{CONFIG_IMPORT}}', options.configImport)
}

export async function dockerfileCms(): Promise<string> {
  return readTemplate('Dockerfile.cms.template')
}

export async function githubWorkflowCms(): Promise<string> {
  return readTemplate('deploy-cms.yml.template')
}
