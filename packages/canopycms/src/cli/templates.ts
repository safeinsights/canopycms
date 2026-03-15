/**
 * File templates for `canopycms init` and `canopycms init-deploy aws`.
 * Reads .template files from the templates/ directory for readability.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.join(__dirname, 'templates')

async function readTemplate(name: string): Promise<string> {
  return fs.readFile(path.join(TEMPLATES_DIR, name), 'utf-8')
}

export async function canopyCmsConfig(options: { mode: string }): Promise<string> {
  const template = await readTemplate('canopycms.config.ts.template')
  return template.replace('{{MODE}}', options.mode)
}

export async function canopyContextClerk(): Promise<string> {
  return readTemplate('canopy.ts.template')
}

export async function schemasTemplate(): Promise<string> {
  return readTemplate('schemas.ts.template')
}

export async function apiRoute(): Promise<string> {
  return readTemplate('route.ts.template')
}

export async function editPageClerk(): Promise<string> {
  return readTemplate('edit-page.tsx.template')
}

export async function dockerfileCms(): Promise<string> {
  return readTemplate('Dockerfile.cms.template')
}

export async function githubWorkflowCms(): Promise<string> {
  return readTemplate('deploy-cms.yml.template')
}
