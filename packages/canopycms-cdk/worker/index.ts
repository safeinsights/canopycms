#!/usr/bin/env node

/**
 * EC2 Worker entrypoint for AWS deployment: reads secrets from Secrets Manager,
 * wires the Clerk-specific auth-cache refresher, and starts the auth-agnostic
 * `CmsWorker` from canopycms core. An adopter on a different auth provider
 * writes their own entrypoint supplying a different `refreshAuthCache`.
 *
 * Only the real side effects live here; the boot sequence is in run.ts so tests
 * can drive it.
 */

import {
  CmsWorker,
  installWorkerLogger,
  recordWorkerStartupFailure,
} from 'canopycms/worker/cms-worker'

import { getSecret } from './secrets'
import { completeTerminationLifecycleAction, watchForTermination } from './termination-watch'
import { runWorker } from './run'

// FIRST, before anything that could log. The imports above only cover code
// this file calls directly; the worker also executes shared canopycms modules
// (github-service.ts's rate-limit callbacks and PR create/update,
// branch-registry.ts's registry scan) that are plain `console` under Lambda
// and must be prefixed here. This points their `canopyLog*` helpers at the
// timestamping functions. See canopycms's utils/logger.ts.
installWorkerLogger()

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
})
