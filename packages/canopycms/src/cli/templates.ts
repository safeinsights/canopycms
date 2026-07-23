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

export async function canopyCmsConfig(options: {
  mode: string
  staticBuild?: boolean
}): Promise<string> {
  const template = await readTemplate('canopycms.config.ts.template')
  // Dual-build sites flip deployedAs per build: the public static export reads
  // content with no auth/request context, while dev and the CMS build run as a
  // server. Defaulting to 'server' is required — the CMS server re-evaluates
  // this config at runtime, and `next dev` must never get 'static'.
  const deployedAs = options.staticBuild
    ? '  // Static public export: build with CANOPY_BUILD=static (CMS build uses CANOPY_BUILD=cms,\n' +
      '  // see next.config.ts). Anything else runs as a server.\n' +
      "  deployedAs: process.env.CANOPY_BUILD === 'static' ? 'static' : 'server',\n"
    : ''
  return template.replace('{{MODE}}', options.mode).replace('{{DEPLOYED_AS}}', deployedAs)
}

export async function canopyContext(options: {
  configImport: string
  authProvider: 'clerk' | 'dev'
}): Promise<string> {
  const template = await readTemplate('canopy.ts.template')

  const authImports =
    options.authProvider === 'clerk'
      ? "import { createClerkAuthPlugin } from 'canopycms-auth-clerk'\nimport { createDevAuthPlugin } from 'canopycms-auth-dev'"
      : "import { createDevAuthPlugin } from 'canopycms-auth-dev'"

  // SEC: never key auth on an env var alone — a missing/misspelled CANOPY_AUTH_MODE in a
  // prod deploy must not silently fall back to the unauthenticated dev plugin. In prod the
  // verifying plugin is always used; construction is cheap and never throws, so if its
  // config/env is missing it throws at the first authenticated request instead.
  const authPluginSetup =
    options.authProvider === 'clerk'
      ? [
          '// Auth plugin selection — fails closed. The dev plugin performs NO real credential',
          "// verification, so it is only ever used when mode is 'dev'. In prod, Clerk is always",
          '// used: if CLERK_SECRET_KEY is missing, createClerkAuthPlugin throws at the first',
          '// authenticated request (construction is cheap, so the zero-editor static build can',
          '// import canopy.ts without the secret), instead of silently falling back to',
          '// unauthenticated dev auth.',
          'const authPlugin =',
          "  config.server.mode === 'prod' || process.env.CANOPY_AUTH_MODE === 'clerk'",
          '    ? createClerkAuthPlugin({ useOrganizationsAsGroups: true })',
          '    : createDevAuthPlugin()',
        ].join('\n')
      : 'const authPlugin = createDevAuthPlugin()'

  return template
    .replace('{{AUTH_IMPORTS}}', authImports)
    .replace('{{AUTH_PLUGIN_SETUP}}', authPluginSetup)
    .replace('{{CONFIG_IMPORT}}', options.configImport)
}

export async function schemasTemplate(): Promise<string> {
  return readTemplate('schemas.ts.template')
}

export async function apiRoute(options: { canopyImport: string }): Promise<string> {
  const template = await readTemplate('route.ts.template')
  return template.replace('{{CANOPY_IMPORT}}', options.canopyImport)
}

export async function editPage(options: {
  configImport: string
  authProvider: 'clerk' | 'dev'
}): Promise<string> {
  const templateName =
    options.authProvider === 'dev' ? 'edit-page-dev.tsx.template' : 'edit-page.tsx.template'
  const template = await readTemplate(templateName)
  return template.replace('{{CONFIG_IMPORT}}', options.configImport)
}

export async function aiConfig(): Promise<string> {
  return readTemplate('ai-config.ts.template')
}

export async function aiRoute(options: { configImport: string }): Promise<string> {
  const template = await readTemplate('ai-route.ts.template')
  return template.replace('{{CONFIG_IMPORT}}', options.configImport)
}

export async function middleware(options: { authProvider: 'clerk' | 'dev' }): Promise<string> {
  const templateName =
    options.authProvider === 'clerk' ? 'middleware-clerk.ts.template' : 'middleware.ts.template'
  return readTemplate(templateName)
}

export async function nextConfig(options: { staticBuild: boolean }): Promise<string> {
  const templateName = options.staticBuild
    ? 'next.config-static.ts.template'
    : 'next.config.ts.template'
  return readTemplate(templateName)
}

export async function dockerfileCms(): Promise<string> {
  return readTemplate('Dockerfile.cms.template')
}

export async function dockerignore(): Promise<string> {
  return readTemplate('dockerignore.template')
}

export async function githubWorkflowCms(): Promise<string> {
  return readTemplate('deploy-cms.yml.template')
}
