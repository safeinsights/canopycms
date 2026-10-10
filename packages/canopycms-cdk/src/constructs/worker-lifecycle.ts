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
 * into every unit it writes, and a bundle refuses to start under a unit whose
 * version is lower.
 *
 * A unit with no stamp predates the stamp, so its version is read from what
 * it observably provides: 1 when `STATE_DIRECTORY` is set (systemd sets it
 * from `StateDirectory=`), else 0. Inference never reads past 1, so from
 * version 2 on only an explicit stamp satisfies a bundle.
 *
 * Append an entry ONLY when the bundle starts to need something new from the
 * unit or template. Anything a bundle merely tolerates the absence of does
 * not count. The bundle's "template too old" line names every entry above the
 * unit's version, so write it as the setting an operator would add.
 */
const WORKER_CONTRACT_REQUIREMENTS = ['StateDirectory=canopy-worker'] as const

/**
 * The worker contract version: stamped into the unit by the construct (and,
 * in parameter mode, into the `WorkerContract` stack output), and published beside the
 * bundle as `worker/dist/index.js.contract`, so a change-set gate can compare
 * the two before rolling a bundle. See {@link WORKER_CONTRACT_REQUIREMENTS}.
 */
export const WORKER_CONTRACT_VERSION = WORKER_CONTRACT_REQUIREMENTS.length

/** The unit's `Environment=` variable carrying its worker contract version. */
export const WORKER_CONTRACT_ENV = 'CANOPYCMS_WORKER_CONTRACT'

/**
 * The unit's worker contract version, read from the worker's environment as
 * {@link WORKER_CONTRACT_REQUIREMENTS} describes, or `NaN` for a stamp that is
 * not a whole number.
 */
export function unitWorkerContract(env: Readonly<Record<string, string | undefined>>): number {
  const stamp = env[WORKER_CONTRACT_ENV]
  if (stamp === undefined) return env.STATE_DIRECTORY ? 1 : 0
  return /^\d+$/.test(stamp) ? Number(stamp) : NaN
}

/**
 * The fatal line for a unit older than this bundle, or `undefined` when the
 * unit's contract is new enough.
 */
export function workerContractShortfall(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const unit = unitWorkerContract(env)
  if (Number.isNaN(unit)) {
    return `canopy-worker: ${WORKER_CONTRACT_ENV}=${JSON.stringify(env[WORKER_CONTRACT_ENV])} on the worker unit is not a whole number`
  }
  if (unit >= WORKER_CONTRACT_VERSION) return undefined
  return (
    `canopy-worker: template too old for this bundle: needs worker contract ` +
    `${WORKER_CONTRACT_VERSION}, unit has ${unit} (` +
    WORKER_CONTRACT_REQUIREMENTS.slice(unit)
      .map((setting, i) => `contract ${unit + i + 1} adds ${setting}`)
      .join('; ') +
    `). Deploy the stack template ` +
    `before rolling this bundle.`
  )
}

/**
 * The text of the line `syncGit()` (canopycms `worker/git-sync.ts`) logs at the
 * start of every git-sync cycle. The worker-down alarm's metric filter counts
 * it, so the alarm misfires if the worker's text drifts from this one.
 */
export const WORKER_SYNC_LOG_PHRASE = 'Syncing git...'
