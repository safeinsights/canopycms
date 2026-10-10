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
 * The worker's exit status after it stopped itself (its EFS lock was
 * compromised). Non-zero, and deliberately not {@link EXIT_DRAINED_FOR_TERMINATION}
 * (75), which the unit lists in `RestartPreventExitStatus=`: this one must let
 * `Restart=always` start a fresh worker. Not in `SuccessExitStatus=` either.
 * 69 is sysexits' EX_UNAVAILABLE.
 */
export const EXIT_WORKER_SELF_STOPPED = 69

/**
 * Set to `spot` in the worker's environment when it runs on spot capacity, which
 * arms the watch for a spot interruption notice.
 */
export const WORKER_CAPACITY_ENV = 'CANOPYCMS_WORKER_CAPACITY'

/**
 * What each worker contract version requires of the unit and template, in
 * order: entry `i` is version `i + 1`. The construct stamps the latest version
 * into every unit it writes; a bundle refuses to start under a unit stamped
 * lower, and a unit with no stamp counts as version 0.
 *
 * Append an entry ONLY when the bundle starts to need something new from the
 * unit or template. Anything a bundle merely tolerates the absence of does
 * not count. Every entry is named in the bundle's "template too old" line, so
 * write it as the setting an operator would add.
 */
const WORKER_CONTRACT_REQUIREMENTS = ['StateDirectory=canopy-worker'] as const

/**
 * The worker contract version: stamped into the unit and the
 * `WorkerContract` stack output by the construct, and published beside the
 * bundle as `worker/dist/index.js.contract`, so a change-set gate can compare
 * the two before rolling a bundle. See {@link WORKER_CONTRACT_REQUIREMENTS}.
 */
export const WORKER_CONTRACT_VERSION = WORKER_CONTRACT_REQUIREMENTS.length

/** The unit's `Environment=` variable carrying its worker contract version. */
export const WORKER_CONTRACT_ENV = 'CANOPYCMS_WORKER_CONTRACT'

/**
 * The fatal line for a unit older than this bundle, or `undefined` when the
 * unit's contract (`unitValue`, the raw environment value) is new enough.
 */
export function workerContractShortfall(unitValue: string | undefined): string | undefined {
  if (unitValue !== undefined && !/^\d+$/.test(unitValue)) {
    return `canopy-worker: ${WORKER_CONTRACT_ENV}=${JSON.stringify(unitValue)} on the worker unit is not a whole number`
  }
  const unit = unitValue === undefined ? 0 : Number(unitValue)
  if (unit >= WORKER_CONTRACT_VERSION) return undefined
  return (
    `canopy-worker: template too old for this bundle: needs worker contract ` +
    `${WORKER_CONTRACT_VERSION}, unit has ${unit} ` +
    `(${WORKER_CONTRACT_REQUIREMENTS.slice(unit).join(', ')}). Deploy the stack template ` +
    `before rolling this bundle.`
  )
}

/**
 * The text of the line `syncGit()` (canopycms `worker/git-sync.ts`) logs at the
 * start of every git-sync cycle. The worker-down alarm's metric filter counts
 * it, so the alarm misfires if the worker's text drifts from this one.
 */
export const WORKER_SYNC_LOG_PHRASE = 'Syncing git...'
