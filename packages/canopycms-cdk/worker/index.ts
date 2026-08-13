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

// workerLog/workerLogError, not bare console: every line in
// /var/log/canopy-worker/worker.log must start with the ISO-8601 timestamp
// these add, or the CloudWatch agent's multi_line_start_pattern folds it into
// the previous event instead of starting a new one. See
// packages/canopycms/src/worker/log.ts.
import {
  CmsWorker,
  workerLog,
  workerLogWarn,
  workerLogError,
  installWorkerLogger,
} from 'canopycms/worker/cms-worker'
import { refreshClerkCache } from 'canopycms-auth-clerk/cache-writer'
import { getErrorMessage } from 'canopycms/utils/error'
import path from 'node:path'

async function getSecret(secretArn: string, retries = 3): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient({})
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }))
      if (!response.SecretString) {
        throw new Error(`Secret ${secretArn} has no string value`)
      }
      return response.SecretString
    } catch (err) {
      if (attempt === retries) throw err
      const delay = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
      workerLog(`Secrets Manager unavailable for ${secretArn}, retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

async function main() {
  // FIRST, before anything that could log. The imports above only cover code
  // this file calls directly; the worker also executes shared canopycms modules
  // (github-service.ts's rate-limit callbacks and PR create/update,
  // branch-registry.ts's registry scan) that are plain `console` under Lambda
  // and must be prefixed here. This points their `canopyLog*` helpers at the
  // timestamping functions. See canopycms's utils/logger.ts.
  installWorkerLogger()

  workerLog('CMS Worker starting...')

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
          // Injected rather than left to default `console.warn`: this runs in
          // the worker, so its per-user membership-fetch warning needs the
          // ISO-8601 prefix like everything else here. canopycms is only a
          // peer dependency of canopycms-auth-clerk, so the join happens at
          // this entrypoint, which already imports both.
          warn: workerLogWarn,
        })
        workerLog(`  ${result.userCount} users, ${result.groupCount} groups`)
      }
    : undefined

  const worker = new CmsWorker({
    workspacePath,
    githubOwner,
    githubRepo,
    githubToken,
    refreshAuthCache,
    baseBranch: process.env.CANOPYCMS_BASE_BRANCH ?? 'main',
    // deploymentName is deliberately NOT passed: CmsWorker resolves it through
    // resolveDeploymentName, which reads CANOPYCMS_DEPLOYMENT_NAME itself
    // (CanopyCmsService stamps that env var from
    // CanopyCmsServiceProps.deploymentName), applies the same env > config >
    // 'prod' precedence as the Lambda, and validates the result as a git ref
    // component. Reading the env var here instead would re-implement the
    // outer half of that chain and skip the validation.
    // Explicit override, matching the strategy's own precedence: an adopter who
    // sets `settingsBranch` in canopycms.config.ts must set this too, or the
    // worker would own a branch name the Lambda never writes to.
    settingsBranch: process.env.CANOPYCMS_SETTINGS_BRANCH,
    taskPollInterval: parseInt(process.env.CANOPYCMS_TASK_POLL_INTERVAL ?? '5000'),
    gitSyncInterval: parseInt(process.env.CANOPYCMS_GIT_SYNC_INTERVAL ?? '300000'),
    authCacheRefreshInterval: parseInt(
      process.env.CANOPYCMS_AUTH_CACHE_REFRESH_INTERVAL ?? '900000',
    ),
  })

  // Graceful shutdown — stop() waits for in-flight operations to drain
  const shutdown = async () => {
    workerLog('Shutting down...')
    await worker.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await worker.start()
}

main().catch((err) => {
  workerLogError('Fatal error:', getErrorMessage(err))
  process.exit(1)
})
