#!/usr/bin/env node

/**
 * EC2 entrypoint for AWS deployment, in the role `argv[2]` names:
 *
 * - none: the worker. Wires the Clerk-specific auth-cache refresher and starts the auth-agnostic
 *   `CmsWorker` from canopycms core. Under the split (`CANOPYCMS_GITHUB_GATEWAY_SOCKET` set) it
 *   holds no secret and reaches GitHub through the gateway; otherwise it reads the secrets from
 *   Secrets Manager itself. An adopter on a different auth provider writes their own entrypoint
 *   supplying a different `refreshAuthCache`.
 * - `gateway`: the GitHub gateway process, which holds the credential and the Clerk key and
 *   serves the worker over a unix socket.
 * - `self-check`: the worker's boot self-checks alone, printed, exiting 1 if any fails.
 *   `canopy-inspect`'s `inspect-checks` (src/constructs/worker-units.ts) runs them before an
 *   operator's command.
 *
 * Only the real side effects live here; the boot sequences are in run.ts and gateway-run.ts so
 * tests can drive them.
 */

import {
  CmsWorker,
  connectGitHubGateway,
  createLocalGitHubGateway,
  gatewaySelfChecks,
  installWorkerLogger,
  recordWorkerStartupFailure,
  serveGitHubGateway,
  workerLogError,
  workerSelfChecks,
} from 'canopycms/worker/cms-worker'
import { writeAuthSnapshot } from 'canopycms/auth/cache'
import { getErrorMessage } from 'canopycms/utils/error'

import { getSecret } from './secrets'
import { completeTerminationLifecycleAction, watchForTermination } from './termination-watch'
import { runWorker } from './run'
import { runGateway } from './gateway-run'

// FIRST, before anything that could log. The imports above only cover code
// this file calls directly; the worker also executes shared canopycms modules
// (github-service.ts's rate-limit callbacks and PR create/update,
// branch-registry.ts's registry scan) that are plain `console` under Lambda
// and must be prefixed here. This points their `canopyLog*` helpers at the
// timestamping functions. See canopycms's utils/logger.ts.
installWorkerLogger()

const role = process.argv[2]

if (role === undefined) {
  void runWorker({
    env: process.env,
    getSecret,
    createWorker: (config) => new CmsWorker(config),
    exit: (code) => process.exit(code),
    onSignal: (signal, handler) => {
      process.on(signal, handler)
    },
    watchForTermination,
    completeTerminationLifecycleAction: () => completeTerminationLifecycleAction(),
    recordWorkerStartupFailure,
    connectGateway: connectGitHubGateway,
    workerSelfChecks: () => workerSelfChecks(),
    writeAuthSnapshot,
  })
} else if (role === 'gateway') {
  void runGateway({
    env: process.env,
    pid: process.pid,
    getSecret,
    exit: (code) => process.exit(code),
    onSignal: (signal, handler) => {
      process.on(signal, handler)
    },
    gatewaySelfChecks: (listen) => gatewaySelfChecks('fd' in listen ? { listenFd: listen.fd } : {}),
    createGateway: createLocalGitHubGateway,
    serve: serveGitHubGateway,
    watchForTermination,
    completeTerminationLifecycleAction: () => completeTerminationLifecycleAction(),
  })
} else if (role === 'self-check') {
  void workerSelfChecks().then(
    (results) => {
      for (const { check, ok, detail } of results) {
        process.stdout.write(`${ok ? 'ok    ' : 'FAILED'} ${check}: ${detail}\n`)
      }
      process.exit(results.every((result) => result.ok) ? 0 : 1)
    },
    (err: unknown) => {
      workerLogError('The self-checks could not run:', getErrorMessage(err))
      process.exit(1)
    },
  )
} else {
  // A mistyped ExecStart must not start as the worker.
  workerLogError(
    `Unknown role ${JSON.stringify(role)}; expected no argument (the worker), "gateway" or "self-check"`,
  )
  process.exit(1)
}
