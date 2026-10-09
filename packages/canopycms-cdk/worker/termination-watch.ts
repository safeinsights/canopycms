/**
 * How the EC2 worker learns its instance is going away, and how it lets the
 * Auto Scaling group finish terminating it once it has drained.
 *
 * Two signals, both read from instance metadata (IMDSv2) on a poll:
 * - `autoscaling/target-lifecycle-state` reads `Terminated` once the ASG has
 *   put this instance into `Terminating:Wait` behind the construct's drain hook
 *   (a deploy that replaces the worker, a scale-in, a health replacement);
 * - `spot/instance-action` appears two minutes before a spot interruption.
 *   Polled only on spot capacity, where it can exist.
 *
 * Lives in `canopycms-cdk`, not core, for the same reason as secrets.ts: core's
 * CmsWorker takes no AWS dependency. Split from index.ts so tests can import it.
 */

import {
  AutoScalingClient,
  CompleteLifecycleActionCommand,
  DescribeAutoScalingInstancesCommand,
} from '@aws-sdk/client-auto-scaling'
import { workerLog, workerLogError, workerLogWarn } from 'canopycms/worker/cms-worker'
import { getErrorMessage } from 'canopycms/utils/error'

import { WORKER_DRAIN_HOOK_NAME } from '../src/constructs/worker-lifecycle'

export interface TerminationNotice {
  kind: 'auto-scaling' | 'spot'
  /** Passed to `CmsWorker.stop()` and recorded as `lastShutdown.reason`. */
  reason: string
}

export interface TerminationWatchOptions {
  /** Poll the spot interruption notice too. True only on spot capacity. */
  watchSpot: boolean
  /** Default 5s: a drain's 90s deadline leaves the spot notice's two minutes ample. */
  pollIntervalMs?: number
  imdsEndpoint?: string
  fetchImpl?: typeof fetch
  /** Resolves the watch's wait between polls; tests replace it. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_IMDS_ENDPOINT = 'http://169.254.169.254'
const IMDS_TIMEOUT_MS = 2_000
/** Per Auto Scaling call: the SDK's default client arms no timer at all (see secrets.ts). */
const AUTO_SCALING_CALL_TIMEOUT_MS = 15_000

/** One IMDSv2 session: a token per read is cheap (link-local) and never goes stale. */
async function imdsGet(
  fetchImpl: typeof fetch,
  endpoint: string,
  metadataPath: string,
): Promise<{ status: number; body: string }> {
  const tokenResponse = await fetchImpl(`${endpoint}/latest/api/token`, {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  })
  if (!tokenResponse.ok) throw new Error(`IMDS token request returned ${tokenResponse.status}`)
  const token = await tokenResponse.text()
  const response = await fetchImpl(`${endpoint}/latest/meta-data/${metadataPath}`, {
    headers: { 'X-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  })
  return { status: response.status, body: response.ok ? await response.text() : '' }
}

/**
 * Resolves when the instance is being terminated; never rejects. A metadata
 * read that fails is logged on the transition to failing and again on
 * recovery, and polling continues: losing this watch only costs the drain,
 * since the hook's heartbeat timeout still lets termination proceed.
 */
export async function watchForTermination(
  options: TerminationWatchOptions,
): Promise<TerminationNotice> {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.imdsEndpoint ?? DEFAULT_IMDS_ENDPOINT
  const pollIntervalMs = options.pollIntervalMs ?? 5_000
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let failing = false

  for (;;) {
    try {
      const lifecycle = await imdsGet(fetchImpl, endpoint, 'autoscaling/target-lifecycle-state')
      if (lifecycle.status === 200 && lifecycle.body.trim() === 'Terminated') {
        return { kind: 'auto-scaling', reason: 'Auto Scaling is terminating the instance' }
      }
      if (options.watchSpot) {
        // 404 until EC2 schedules an interruption.
        const spot = await imdsGet(fetchImpl, endpoint, 'spot/instance-action')
        if (spot.status === 200) {
          return { kind: 'spot', reason: `spot interruption notice (${spot.body.trim()})` }
        }
      }
      if (failing) {
        failing = false
        workerLog('Instance metadata reachable again; termination watch resumed')
      }
    } catch (err) {
      if (!failing) {
        failing = true
        workerLogWarn(
          `Cannot read instance metadata (${getErrorMessage(err)}); the worker will not drain ` +
            'before termination until it can. Retrying.',
        )
      }
    }
    await sleep(pollIntervalMs)
  }
}

/**
 * Let the ASG finish terminating this instance: `CompleteLifecycleAction`
 * CONTINUE on the drain hook. Never throws -- if it fails, the hook's
 * heartbeat timeout continues the termination anyway, only later.
 *
 * The group's name comes from DescribeAutoScalingInstances rather than the
 * worker's environment because the environment is baked into the launch
 * template the group itself depends on.
 */
export async function completeTerminationLifecycleAction(
  options: {
    client?: Pick<AutoScalingClient, 'send'>
    imdsEndpoint?: string
    fetchImpl?: typeof fetch
  } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.imdsEndpoint ?? DEFAULT_IMDS_ENDPOINT
  const client = options.client ?? new AutoScalingClient({ maxAttempts: 3 })
  try {
    const instance = await imdsGet(fetchImpl, endpoint, 'instance-id')
    const instanceId = instance.body.trim()
    if (instance.status !== 200 || !instanceId) {
      throw new Error(`instance-id lookup returned ${instance.status}`)
    }
    const described = await client.send(
      new DescribeAutoScalingInstancesCommand({ InstanceIds: [instanceId] }),
      { abortSignal: AbortSignal.timeout(AUTO_SCALING_CALL_TIMEOUT_MS) },
    )
    const groupName = described.AutoScalingInstances?.[0]?.AutoScalingGroupName
    if (!groupName) throw new Error(`${instanceId} is not in an Auto Scaling group`)
    await client.send(
      new CompleteLifecycleActionCommand({
        AutoScalingGroupName: groupName,
        LifecycleHookName: WORKER_DRAIN_HOOK_NAME,
        InstanceId: instanceId,
        LifecycleActionResult: 'CONTINUE',
      }),
      { abortSignal: AbortSignal.timeout(AUTO_SCALING_CALL_TIMEOUT_MS) },
    )
    workerLog(`Completed lifecycle hook ${WORKER_DRAIN_HOOK_NAME}; termination continues`)
  } catch (err) {
    workerLogError(
      `Could not complete lifecycle hook ${WORKER_DRAIN_HOOK_NAME} (${getErrorMessage(err)}); ` +
        'termination continues when its heartbeat times out',
    )
  }
}
