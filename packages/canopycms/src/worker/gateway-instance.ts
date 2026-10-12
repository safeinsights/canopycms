import { getErrorMessage } from '../utils/error'
import {
  gatewayLogError,
  gatewayLogWarn,
  redactEgress,
  redactError,
  redactValue,
} from './gateway-egress'
import type { GatewayTerminationNotice } from './github-gateway'

/** How long one `termination()` poll waits for a notice before answering that none came. */
const TERMINATION_POLL_WAIT_MS = 25_000

/**
 * How long `completeLifecycle` watches for a notice it has not seen: one read of the instance's
 * metadata, which a terminating instance answers at once.
 */
const LIFECYCLE_NOTICE_WAIT_MS = 10_000

export interface GatewayInstanceOptions {
  /**
   * Resolves once the instance is being terminated. Started at the first `termination()` or
   * `completeLifecycle()` call, once; a rejection is logged and the next call starts it again.
   */
  watchTermination?: () => Promise<GatewayTerminationNotice>
  /** Completes the Auto Scaling lifecycle action. Never rejects by contract: the provider logs its own failure. */
  completeLifecycle?: () => Promise<void>
  /** Test seam: one `termination()` poll's wait (default {@link TERMINATION_POLL_WAIT_MS}). */
  terminationPollWaitMs?: number
}

/**
 * The gateway's two operations on the instance itself, `termination` and `completeLifecycle`
 * (see {@link GitHubGateway}). They need only the instance role, never the GitHub credential, so
 * a gateway that failed to boot serves them too (canopycms-cdk `worker/gateway-run.ts`).
 */
export class GatewayInstance {
  /** Whether the termination watch is running: started by a poll, and again by one after it failed. */
  private terminationWatching = false
  /** The notice this gateway's own termination watch saw; null until it sees one. */
  private terminationNotice: GatewayTerminationNotice | null = null
  /**
   * The polls waiting for a notice, each removed when its poll ends. A set, not reactions on one
   * long-lived promise: those would pile up, one per poll, for the instance's whole life.
   */
  private readonly terminationWaiters = new Set<(notice: GatewayTerminationNotice) => void>()
  /** Whether the gateway's own watch has seen an Auto Scaling notice: what `completeLifecycle` requires. */
  private sawAutoScalingNotice = false
  /** The one `completeLifecycle` provider call, which every call answers. */
  private lifecycleCompletion: Promise<void> | null = null

  constructor(private readonly options: GatewayInstanceOptions) {}

  async termination(signal?: AbortSignal): Promise<GatewayTerminationNotice | null> {
    if (this.terminationNotice !== null) return this.terminationNotice
    this.startTerminationWatch()
    // A failed watch leaves the poll waiting its whole period, so a client polling in a loop is paced.
    return this.waitForTerminationNotice(
      this.options.terminationPollWaitMs ?? TERMINATION_POLL_WAIT_MS,
      signal,
    )
  }

  async completeLifecycle(signal?: AbortSignal): Promise<void> {
    const complete = this.options.completeLifecycle
    if (complete === undefined) {
      gatewayLogWarn(
        'Nothing completes the Auto Scaling lifecycle action: no provider is configured',
      )
      return
    }
    // Only an Auto Scaling notice this gateway's own watch observed opens it: a worker cannot be
    // trusted to say the instance is terminating, and completing the action ends the instance. A
    // gateway restarted after the worker had its notice has not watched yet, so it watches now,
    // for a bounded wait, before it refuses.
    if (!this.sawAutoScalingNotice) {
      this.startTerminationWatch()
      await this.waitForTerminationNotice(
        Math.min(
          this.options.terminationPollWaitMs ?? TERMINATION_POLL_WAIT_MS,
          LIFECYCLE_NOTICE_WAIT_MS,
        ),
        signal,
      )
    }
    if (!this.sawAutoScalingNotice) {
      throw new Error(
        'The GitHub gateway has seen no Auto Scaling termination, so it will not complete the lifecycle action',
      )
    }
    // `signal` ends only this caller's wait: a started CompleteLifecycleAction is not taken back.
    try {
      await untilAborted((this.lifecycleCompletion ??= complete()), signal)
    } catch (err) {
      throw redactError(err)
    }
  }

  /** Start the termination watch unless it runs or has seen a notice; a failure is logged, and the next poll starts it again. */
  private startTerminationWatch(): void {
    const watchTermination = this.options.watchTermination
    if (watchTermination === undefined || this.terminationWatching) return
    if (this.terminationNotice !== null) return
    this.terminationWatching = true
    void (async () => watchTermination())().then(
      (notice) => {
        this.terminationWatching = false
        const scrubbed = redactValue(notice)
        this.terminationNotice = scrubbed
        if (notice.kind === 'auto-scaling') this.sawAutoScalingNotice = true
        for (const waiter of [...this.terminationWaiters]) waiter(scrubbed)
      },
      (err: unknown) => {
        this.terminationWatching = false
        gatewayLogError('The termination watch failed:', redactEgress(getErrorMessage(err)))
      },
    )
  }

  /** The watch's notice, or null after `waitMs`; rejects with `signal`'s reason when it aborts first. */
  private waitForTerminationNotice(
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<GatewayTerminationNotice | null> {
    if (this.terminationNotice !== null) return Promise.resolve(this.terminationNotice)
    signal?.throwIfAborted()
    return new Promise<GatewayTerminationNotice | null>((resolve, reject) => {
      const end = () => {
        clearTimeout(timer)
        this.terminationWaiters.delete(onNotice)
        signal?.removeEventListener('abort', onAbort)
      }
      const onNotice = (notice: GatewayTerminationNotice) => {
        end()
        resolve(notice)
      }
      const onAbort = () => {
        end()
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        end()
        resolve(null)
      }, waitMs)
      this.terminationWaiters.add(onNotice)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** `promise`, unless `signal` aborts first, which ends only this wait. */
export async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  let onAbort = (): void => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
