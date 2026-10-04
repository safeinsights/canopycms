#!/usr/bin/env node

/**
 * EC2 Worker entrypoint for AWS deployment: reads secrets from Secrets Manager,
 * wires the Clerk-specific auth-cache refresher, and starts the auth-agnostic
 * `CmsWorker` from canopycms core. An adopter on a different auth provider
 * writes their own entrypoint supplying a different `refreshAuthCache`.
 */

// workerLog/workerLogError, not bare console: every line in
// /var/log/canopy-worker/worker.log must start with the ISO-8601 timestamp
// these add, or the CloudWatch agent's multi_line_start_pattern folds it into
// the previous event instead of starting a new one. See
// packages/canopycms/src/worker/log.ts.
import {
  CmsWorker,
  workerLog,
  workerLogError,
  installWorkerLogger,
} from 'canopycms/worker/cms-worker'
import { getErrorMessage } from 'canopycms/utils/error'
import path from 'node:path'

import { getSecret } from './secrets'
import { buildGitHubAppAuth } from './github-app-auth'
import { createReactiveSecret } from './credential-refresh'
import { createClerkAuthCacheRefresher } from './clerk-refresh'

async function main() {
  // FIRST, before anything that could log. The imports above only cover code
  // this file calls directly; the worker also executes shared canopycms modules
  // (github-service.ts's rate-limit callbacks and PR create/update,
  // branch-registry.ts's registry scan) that are plain `console` under Lambda
  // and must be prefixed here. This points their `canopyLog*` helpers at the
  // timestamping functions. See canopycms's utils/logger.ts.
  installWorkerLogger()

  workerLog('CMS Worker starting...')

  const workspacePath = process.env.CANOPYCMS_WORKSPACE_ROOT
  if (!workspacePath) throw new Error('CANOPYCMS_WORKSPACE_ROOT is required')

  const githubOwner = process.env.CANOPYCMS_GITHUB_OWNER
  if (!githubOwner) throw new Error('CANOPYCMS_GITHUB_OWNER is required')

  const githubRepo = process.env.CANOPYCMS_GITHUB_REPO
  if (!githubRepo) throw new Error('CANOPYCMS_GITHUB_REPO is required')

  // Secrets from Secrets Manager or env vars.
  //
  // The ARN is resolved to `undefined` when the plain env var supplied the
  // value, which keeps the existing precedence (env var wins, the ARN is read
  // only in its absence) AND is what tells the reactive reader below there is
  // nothing behind this credential to re-read. Re-reading an ARN the
  // deployment deliberately overrode would swap the override back out.
  const githubTokenFromEnv = process.env.CANOPYCMS_GITHUB_TOKEN
  const githubTokenArn = githubTokenFromEnv
    ? undefined
    : process.env.CANOPYCMS_GITHUB_TOKEN_SECRET_ARN
  const githubTokenSecretOptions = {
    // `|| undefined` rather than passing the env var straight through: a var
    // that is present but blank means "not configured", so `getSecret` should
    // take the unchanged whole-value path rather than hunt for a field named
    // ''. The var name is passed too, so the warning `getSecret` logs when it
    // finds an unread JSON document can name the exact thing to set.
    jsonField: process.env.CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD || undefined,
    jsonFieldEnvVar: 'CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD',
  }
  const githubToken = githubTokenArn
    ? await getSecret(githubTokenArn, githubTokenSecretOptions)
    : githubTokenFromEnv
  // Wrapped so a rotated token reaches a RUNNING worker. Reactive: core calls
  // `refreshGitHubToken` only when a git sync or a task has just failed, so a
  // healthy worker makes no Secrets Manager calls after boot. Constructed even
  // under GitHub App auth, where it is inert - `resolveWorkerGitHubAuth` never
  // calls the provider there, because an App mints its own tokens.
  const githubTokenSecret = createReactiveSecret({
    arn: githubTokenArn,
    initial: githubToken,
    ...githubTokenSecretOptions,
  })
  // GitHub App authentication, if this deployment uses it instead of a token.
  // Checked all-or-nothing HERE as well as at synth (assertGitHubAuthProps in
  // src/constructs/cms-service.ts), because the construct is the normal way
  // these arrive but not the only one: an adopter can set the instance's
  // environment directly, and half a credential otherwise fails at the first
  // push, hours after boot.
  //
  // Nothing here touches the token path above. Both are passed to CmsWorker when
  // both are configured, and core's resolveWorkerGitHubAuth refuses that pair by
  // name rather than picking a winner here - a silent precedence would leave it
  // undefined which identity the worker's pushes and pull requests act as.
  const githubAppId = process.env.CANOPYCMS_GITHUB_APP_ID
  const githubAppInstallationId = process.env.CANOPYCMS_GITHUB_APP_INSTALLATION_ID
  const githubAppPrivateKeySecretArn = process.env.CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN
  const githubAppVars: Array<[string, string | undefined]> = [
    ['CANOPYCMS_GITHUB_APP_ID', githubAppId],
    ['CANOPYCMS_GITHUB_APP_INSTALLATION_ID', githubAppInstallationId],
    ['CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN', githubAppPrivateKeySecretArn],
  ]
  const githubAppMissing = githubAppVars.filter(([, value]) => !value).map(([name]) => name)
  if (githubAppMissing.length > 0 && githubAppMissing.length < githubAppVars.length) {
    throw new Error(
      `GitHub App authentication needs all of ${githubAppVars.map(([name]) => name).join(', ')}, ` +
        `but ${githubAppMissing.join(' and ')} ` +
        `${githubAppMissing.length === 1 ? 'is' : 'are'} not set. An installation token is minted ` +
        `from all three together, so a partial set cannot authenticate at all.`,
    )
  }

  const githubAppAuth =
    githubAppId && githubAppInstallationId && githubAppPrivateKeySecretArn
      ? buildGitHubAppAuth({
          appId: githubAppId,
          installationId: githubAppInstallationId,
          // Same `|| undefined` as the other two `getSecret` call sites in this
          // file, for the same reason: a blank var means "not configured", not
          // "read the field named ''".
          privateKey: await getSecret(githubAppPrivateKeySecretArn, {
            jsonField: process.env.CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD || undefined,
            jsonFieldEnvVar: 'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD',
          }),
        })
      : undefined

  // `!githubAppAuth` as well: an App-authenticated worker has no token and must
  // not be told one is required. With neither configured this still reports the
  // token first, because the token is the default path and the one nearly every
  // deployment uses.
  if (!githubToken && !githubAppAuth)
    throw new Error(
      'CANOPYCMS_GITHUB_TOKEN or CANOPYCMS_GITHUB_TOKEN_SECRET_ARN is required ' +
        '(or the CANOPYCMS_GITHUB_APP_ID / _INSTALLATION_ID / _PRIVATE_KEY_SECRET_ARN trio, ' +
        'to authenticate as a GitHub App installation instead)',
    )

  // Same shape as the GitHub token above, and for the same reasons.
  const clerkKeyFromEnv = process.env.CLERK_SECRET_KEY
  const clerkKeyArn = clerkKeyFromEnv ? undefined : process.env.CLERK_SECRET_KEY_SECRET_ARN
  const clerkKeySecretOptions = {
    jsonField: process.env.CLERK_SECRET_KEY_SECRET_JSON_FIELD || undefined,
    jsonFieldEnvVar: 'CLERK_SECRET_KEY_SECRET_JSON_FIELD',
  }
  const clerkSecret = createReactiveSecret({
    arn: clerkKeyArn,
    initial: clerkKeyArn ? await getSecret(clerkKeyArn, clerkKeySecretOptions) : clerkKeyFromEnv,
    ...clerkKeySecretOptions,
  })

  // The re-read on a Clerk-rejected key lives inside this callback rather than
  // in core -- see clerk-refresh.ts for why.
  const refreshAuthCache = createClerkAuthCacheRefresher({
    secret: clerkSecret,
    cachePath: path.join(workspacePath, '.cache'),
  })

  const worker = new CmsWorker({
    workspacePath,
    githubOwner,
    githubRepo,
    githubToken,
    githubAppAuth,
    // Re-read the PAT when a git sync or a task fails. Inert under App auth, where
    // `resolveWorkerGitHubAuth` never calls it.
    refreshGitHubToken: () => githubTokenSecret.refresh(),
    refreshAuthCache,
    baseBranch: process.env.CANOPYCMS_BASE_BRANCH ?? 'main',
    // deploymentName is deliberately NOT passed: CmsWorker resolves it through
    // resolveDeploymentName, which reads CANOPYCMS_DEPLOYMENT_NAME itself,
    // applies the same env > config > 'prod' precedence as the Lambda, and
    // validates the result as a git ref component. Reading the env var here
    // would re-implement the outer half of that chain and skip the validation.
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
