/**
 * File templates for `canopycms init` and `canopycms init-deploy aws`.
 * Each function returns the file content as a string.
 */

export function canopyCmsConfig(options: { mode: string }): string {
  return `import { defineCanopyConfig } from 'canopycms'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
  mode: '${options.mode}',
  gitBotAuthorName: 'CanopyCMS Bot',
  gitBotAuthorEmail: 'canopycms-bot@example.com',
  editor: {
    title: 'CanopyCMS Editor',
  },
})
`
}

export function canopyContextClerk(): string {
  return `import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import type { AuthPlugin } from 'canopycms/auth'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

function getAuthPlugin(): AuthPlugin {
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

  if (authMode === 'dev') {
    return createDevAuthPlugin()
  }

  if (authMode === 'clerk') {
    return createClerkAuthPlugin({
      useOrganizationsAsGroups: true,
    })
  }

  throw new Error(
    \`Invalid CANOPY_AUTH_MODE: "\${authMode}". Must be "dev" or "clerk".\`
  )
}

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: getAuthPlugin(),
  entrySchemaRegistry,
})

export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
`
}

export function schemasTemplate(): string {
  return `import { defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// Define your entry schemas here.
// Each schema describes the fields for a content type.
// The schema name should match the "entrySchema" value in your .collection.json files.

export const pageSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'description', type: 'string', label: 'Description' },
  { name: 'body', type: 'markdown', label: 'Body' },
])

export const entrySchemaRegistry = createEntrySchemaRegistry({
  pageSchema,
})
`
}

export function apiRoute(): string {
  return `import { getHandler } from '../../../lib/canopy'
import type { NextRequest } from 'next/server'

const handler = getHandler()

export const GET = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const POST = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const PUT = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const PATCH = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
export const DELETE = async (req: NextRequest, ctx: any) => (await handler)(req, ctx)
`
}

export function editPageClerk(): string {
  return `'use client'

import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

function useAuthConfig() {
  const authMode = process.env.NEXT_PUBLIC_CANOPY_AUTH_MODE || 'dev'

  if (authMode === 'dev') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDevAuthConfig()
  }

  if (authMode === 'clerk') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useClerkAuthConfig()
  }

  throw new Error(
    \`Invalid NEXT_PUBLIC_CANOPY_AUTH_MODE: "\${authMode}". Must be "dev" or "clerk".\`
  )
}

export default function EditPage() {
  const authConfig = useAuthConfig()
  const clientConfig = config.client(authConfig)

  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
`
}

export function dockerfileCms(): string {
  return `FROM public.ecr.aws/docker/library/node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV CANOPY_BUILD=cms
RUN npm run build

FROM public.ecr.aws/docker/library/node:20-slim AS runner
# Git is required by CanopyCMS for branch operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
# Lambda Web Adapter converts Lambda events to HTTP
COPY --from=public.ecr.aws/awsguru/aws-lambda-web-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
ENV PORT=8080 AWS_LWA_PORT=8080 HOSTNAME=0.0.0.0 NODE_ENV=production
CMD ["node", "server.js"]
`
}

export function githubWorkflowCms(): string {
  return `# CanopyCMS deployment workflow
# Customize this for your CI/CD setup

name: Deploy CMS
on:
  push:
    paths:
      - 'app/**'
      - 'src/**'
      - 'content/**'
      - 'canopycms.config.ts'
      - 'Dockerfile.cms'
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      # TODO: Configure your ECR login, Docker build, push, and Lambda update
      # See https://canopycms.dev/deploy/aws for details
      - name: Build CMS image
        run: docker build -f Dockerfile.cms -t cms:latest .
`
}
