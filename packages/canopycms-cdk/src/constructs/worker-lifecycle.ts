/**
 * Names the construct (cms-service.ts) and the worker it deploys
 * (worker/index.ts) must agree on. Dependency-free, because the worker bundle
 * imports it and must not pull in aws-cdk-lib.
 */

/** The ASG terminating lifecycle hook the worker completes once it has drained. */
export const WORKER_DRAIN_HOOK_NAME = 'canopycms-worker-drain'

/**
 * The worker's exit status after draining for an instance termination. The
 * systemd unit lists it in `RestartPreventExitStatus=`, so `Restart=always`
 * does not start a fresh worker on an instance about to disappear.
 */
export const EXIT_DRAINED_FOR_TERMINATION = 75

/**
 * Set to `spot` in the worker's environment when it runs on spot capacity, which
 * arms the watch for a spot interruption notice.
 */
export const WORKER_CAPACITY_ENV = 'CANOPYCMS_WORKER_CAPACITY'

/**
 * The text of the line `syncGit()` (canopycms `worker/git-sync.ts`) logs at the
 * start of every git-sync cycle. The worker-down alarm's metric filter counts
 * it, so the alarm misfires if the worker's text drifts from this one.
 */
export const WORKER_SYNC_LOG_PHRASE = 'Syncing git...'
