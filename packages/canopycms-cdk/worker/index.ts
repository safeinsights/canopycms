#!/usr/bin/env node

/**
 * EC2 Worker entrypoint.
 * Reads configuration from environment variables and Secrets Manager,
 * then starts the CMS worker daemon.
 */

import { CmsWorker } from '../src/worker'

async function getSecret(secretArn: string): Promise<string> {
  // Dynamic import to avoid requiring AWS SDK at module load time
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
  if (!clerkSecretKey)
    throw new Error('CLERK_SECRET_KEY or CLERK_SECRET_KEY_SECRET_ARN is required')

  const worker = new CmsWorker({
    workspacePath,
    githubOwner,
    githubRepo,
    githubToken,
    clerkSecretKey,
    baseBranch: process.env.CANOPYCMS_BASE_BRANCH ?? 'main',
    taskPollInterval: parseInt(process.env.CANOPYCMS_TASK_POLL_INTERVAL ?? '5000'),
    gitSyncInterval: parseInt(process.env.CANOPYCMS_GIT_SYNC_INTERVAL ?? '300000'),
    clerkRefreshInterval: parseInt(process.env.CANOPYCMS_CLERK_REFRESH_INTERVAL ?? '900000'),
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
