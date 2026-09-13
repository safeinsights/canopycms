/**
 * What `createReactiveSecret` actually costs in `GetSecretValue` calls.
 *
 * **Every assertion here counts calls or reads returned values — none of them
 * matches a log line.** A rate limiter tested by asserting that it logged
 * "skipping" passes with the limiter deleted, which is the exact shape
 * `.claude/future-tasks/iam-dedupe-tests-pass-vacuously.md` records: 480 tests
 * stayed green with the code under test removed. The clock is injected so the
 * interval is observed directly rather than waited out.
 *
 * `vi.mock` + `importOriginal` rather than `mockClient(SecretsManagerClient)`,
 * which does not typecheck in this package — see the long note at the top of
 * `secrets.test.ts` for the two-copies-of-`@smithy/types` reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` factories are hoisted above the imports, so the spy has to be
// created in a `vi.hoisted` block to exist by the time the factory runs.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-secrets-manager')>()
  return {
    ...actual,
    SecretsManagerClient: class {
      send = sendMock
    },
  }
})

import { createReactiveSecret, DEFAULT_MIN_SECRET_READ_INTERVAL_MS } from './credential-refresh'

const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:canopy/github-AbCdEf'

/**
 * Swallowed, not merely tolerated: `createReactiveSecret` calls `workerLog` on
 * a changed value, and `quietTestOutput.onConsoleLog` in `vitest.shared.ts`
 * THROWS on any stdout write when `CI` is set — which would leave a green test
 * count and a non-zero exit. Same reasoning as `secrets.test.ts`'s `logSpy`.
 */
let logSpy: ReturnType<typeof vi.spyOn>

/** A clock the test drives, so an interval is observed rather than waited out. */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

beforeEach(() => {
  sendMock.mockReset()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

/** Queue the value each successive `GetSecretValue` returns. */
function secretReturns(...values: string[]): void {
  for (const value of values) sendMock.mockResolvedValueOnce({ SecretString: value })
}

describe('guard: nothing to re-read', () => {
  it('makes no call at all when no ARN is configured', async () => {
    const secret = createReactiveSecret({ initial: 'from-env-var' })

    await expect(secret.refresh()).resolves.toBeUndefined()

    // The credential came from a plain env var. There is no ARN behind it, so
    // a re-read cannot produce anything and must not be attempted.
    expect(sendMock).not.toHaveBeenCalled()
    expect(secret.current()).toBe('from-env-var')
  })

  it('still makes no call after many refreshes', async () => {
    const secret = createReactiveSecret({ initial: 'from-env-var' })

    for (let i = 0; i < 50; i++) await secret.refresh()

    expect(sendMock).toHaveBeenCalledTimes(0)
  })
})

describe('guard: too soon', () => {
  it('reads once, then not again until minIntervalMs has passed', async () => {
    const clock = fakeClock()
    secretReturns('same', 'same', 'same')
    const secret = createReactiveSecret({ arn: ARN, initial: 'same', now: clock.now })

    // First failure after boot: reads immediately. `lastReadAt` starts unset
    // rather than at boot time, so nothing is waited out here.
    await secret.refresh()
    expect(sendMock).toHaveBeenCalledTimes(1)

    // One millisecond short of the interval — still blocked.
    clock.advance(DEFAULT_MIN_SECRET_READ_INTERVAL_MS - 1)
    await secret.refresh()
    expect(sendMock).toHaveBeenCalledTimes(1)

    // Exactly at the interval — permitted.
    clock.advance(1)
    await secret.refresh()
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('caps a permanently-failing fast loop at one read per interval', async () => {
    const clock = fakeClock()
    // A wrong-but-unchanging secret, asked about far more often than the floor.
    sendMock.mockResolvedValue({ SecretString: 'the-wrong-key' })
    const secret = createReactiveSecret({ arn: ARN, initial: 'the-wrong-key', now: clock.now })

    // Six hours of a 10-second sync interval: 2,160 failures.
    const SIX_HOURS_MS = 6 * 60 * 60_000
    for (let elapsed = 0; elapsed < SIX_HOURS_MS; elapsed += 10_000) {
      await secret.refresh()
      clock.advance(10_000)
    }

    // 6h at one read per 5 minutes is 72 — not 2,160. This is the number the
    // circuit breaker exists to hold down, so it is asserted exactly.
    expect(sendMock).toHaveBeenCalledTimes(SIX_HOURS_MS / DEFAULT_MIN_SECRET_READ_INTERVAL_MS)
  })

  it('issues ONE read when overlapping calls land before the first resolves', async () => {
    const clock = fakeClock()
    sendMock.mockResolvedValue({ SecretString: 'unchanged' })
    const secret = createReactiveSecret({ arn: ARN, initial: 'unchanged', now: clock.now })

    // `lastReadAt` is stamped BEFORE the await for this case; stamped after,
    // all three callers see an unstamped clock and all three read.
    //
    // The GitHub token's two triggers -- a failed task and a failed git sync --
    // run on separate loops and can overlap, so this is what keeps the floor
    // shared between them.
    await Promise.all([secret.refresh(), secret.refresh(), secret.refresh()])

    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('honours minIntervalMs: 0 as opt-out rather than blocking on an equal timestamp', async () => {
    const clock = fakeClock()
    sendMock.mockResolvedValue({ SecretString: 'unchanged' })
    const secret = createReactiveSecret({
      arn: ARN,
      initial: 'unchanged',
      minIntervalMs: 0,
      now: clock.now,
    })

    // Three refreshes at the SAME instant. With a `>` comparison instead of
    // `>=`, `0 - 0 < 0` is false only by luck of operator; this pins it.
    await secret.refresh()
    await secret.refresh()
    await secret.refresh()

    expect(sendMock).toHaveBeenCalledTimes(3)
  })
})

describe('guard: unchanged', () => {
  it('reports "nothing to do" when the re-read matches what is held', async () => {
    secretReturns('sk_live_original')
    const secret = createReactiveSecret({ arn: ARN, initial: 'sk_live_original' })

    // The call WAS made — this guard is about the answer, not about skipping
    // the read — but the caller is told not to retry.
    await expect(secret.refresh()).resolves.toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(secret.current()).toBe('sk_live_original')
  })

  it('returns the new value and adopts it when the secret has rotated', async () => {
    secretReturns('sk_live_rotated')
    const secret = createReactiveSecret({ arn: ARN, initial: 'sk_live_original' })

    await expect(secret.refresh()).resolves.toBe('sk_live_rotated')
    expect(secret.current()).toBe('sk_live_rotated')
  })

  it('compares against the ROTATED value, not the boot value, on the next round', async () => {
    const clock = fakeClock()
    secretReturns('second', 'second')
    const secret = createReactiveSecret({ arn: ARN, initial: 'first', now: clock.now })

    await expect(secret.refresh()).resolves.toBe('second')

    clock.advance(DEFAULT_MIN_SECRET_READ_INTERVAL_MS)
    // Still 'second'. Comparing against the boot value 'first' would report a
    // rotation that already happened as a fresh one, every interval forever.
    await expect(secret.refresh()).resolves.toBeUndefined()
  })
})

describe('reading the secret', () => {
  it('passes GetSecretOptions through, so a JSON field is honoured', async () => {
    secretReturns(JSON.stringify({ CLERK_SECRET_KEY: 'sk_live_rotated', OTHER: 'x' }))
    const secret = createReactiveSecret({
      arn: ARN,
      initial: 'sk_live_original',
      jsonField: 'CLERK_SECRET_KEY',
    })

    await expect(secret.refresh()).resolves.toBe('sk_live_rotated')
  })

  it('treats a plain non-JSON secret as the whole credential, as at boot', async () => {
    secretReturns('ghp_rotated_plain_value')
    const secret = createReactiveSecret({ arn: ARN, initial: 'ghp_original' })

    // No jsonField configured: the value is the credential, byte for byte.
    await expect(secret.refresh()).resolves.toBe('ghp_rotated_plain_value')
  })

  it('propagates a read failure rather than silently holding the old value', async () => {
    // `retries: 0` so the one rejection is the whole attempt; the default 3
    // would sleep 1s/2s/4s inside this test.
    sendMock.mockRejectedValue(new Error('AccessDeniedException'))
    const secret = createReactiveSecret({ arn: ARN, initial: 'ghp_original', retries: 0 })

    await expect(secret.refresh()).rejects.toThrow('AccessDeniedException')
    expect(secret.current()).toBe('ghp_original')
  })
})

describe('a read that lands after a newer one', () => {
  it('is discarded, so a stalled read cannot put the older value back', async () => {
    const clock = fakeClock()
    let releaseSlow!: (response: { SecretString: string }) => void
    sendMock
      .mockReturnValueOnce(new Promise((resolve) => (releaseSlow = resolve)))
      .mockResolvedValueOnce({ SecretString: 'rotated' })
    const secret = createReactiveSecret({
      arn: ARN,
      initial: 'boot',
      minIntervalMs: 100,
      now: clock.now,
    })

    // The first read reaches Secrets Manager and stalls past the floor.
    const slow = secret.refresh()
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))
    clock.advance(100)

    // A newer read, permitted by the expired floor, adopts the rotated value.
    expect(await secret.refresh()).toBe('rotated')

    // The stalled read finally answers with what the store held before.
    releaseSlow({ SecretString: 'boot-era' })
    expect(await slow).toBeUndefined()
    expect(secret.current()).toBe('rotated')
  })
})
