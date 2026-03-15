#!/usr/bin/env node

/**
 * EC2 Worker entrypoint for AWS deployment.
 *
 * This is the AWS-specific entrypoint that:
 * - Reads secrets from Secrets Manager
 * - Wires up the Clerk-specific auth cache refresher
 * - Starts the auth-agnostic CmsWorker from canopycms core
 *
 * Adopters using a different auth provider would create their own
 * entrypoint that provides a different refreshAuthCache callback.
 */

import { CmsWorker } from '../src/worker'
import { refreshClerkCache } from 'canopycms-auth-clerk/cache-writer'
import path from 'node:path'

async function getSecret(secretArn: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient({})
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }))
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`)
  }
  return response.SecretString
}

async function main() {
  console.log('CMS Worker starting...')

  // Required env vars
  const workspacePath = process.env.CANOPYCMS_WORKSPACE_ROOT
  if (!workspacePath) throw new Error('CANOPYCMS_WORKSPACE_ROOT is required')

  const githubOwner = process.env.CANOPYCMS_GITHUB_OWNER
  if (!githubOwner) throw new Error('CANOPYCMS_GITHUB_OWNER is required')

  const githubRepo = process.env.CANOPYCMS_GITHUB_REPO
  if (!githubRepo) throw new Error('CANOPYCMS_GITHUB_REPO is required')

  // Secrets from Secrets Manager or env vars
  let githubToken = process.env.CANOPYCMS_GITHUB_TOKEN
  if (!githubToken && process.env.CANOPYCMS_GITHUB_TOKEN_SECRET_ARN) {
    githubToken = await getSecret(process.env.CANOPYCMS_GITHUB_TOKEN_SECRET_ARN)
  }
  if (!githubToken)
    throw new Error('CANOPYCMS_GITHUB_TOKEN or CANOPYCMS_GITHUB_TOKEN_SECRET_ARN is required')

  let clerkSecretKey = process.env.CLERK_SECRET_KEY
  if (!clerkSecretKey && process.env.CLERK_SECRET_KEY_SECRET_ARN) {
    clerkSecretKey = await getSecret(process.env.CLERK_SECRET_KEY_SECRET_ARN)
  }

  // Build auth cache refresher (Clerk-specific)
  const cachePath = path.join(workspacePath, '.cache')
  const refreshAuthCache = clerkSecretKey
    ? async () => {
        const result = await refreshClerkCache({
          secretKey: clerkSecretKey,
          cachePath,
          useOrganizationsAsGroups: true,
        })
        console.log(`  ${result.userCount} users, ${result.groupCount} groups`)
      }
    : undefined

  const worker = new CmsWorker({
    workspacePath,
    githubOwner,
    githubRepo,
    githubToken,
    refreshAuthCache,
    baseBranch: process.env.CANOPYCMS_BASE_BRANCH ?? 'main',
    taskPollInterval: parseInt(process.env.CANOPYCMS_TASK_POLL_INTERVAL ?? '5000'),
    gitSyncInterval: parseInt(process.env.CANOPYCMS_GIT_SYNC_INTERVAL ?? '300000'),
    authCacheRefreshInterval: parseInt(
      process.env.CANOPYCMS_AUTH_CACHE_REFRESH_INTERVAL ?? '900000',
    ),
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...')
    await worker.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await worker.start()
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
