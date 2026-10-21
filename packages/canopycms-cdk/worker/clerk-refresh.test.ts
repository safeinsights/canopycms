/**
 * When the Clerk auth-cache refresher re-reads its secret key, and when it
 * refuses to.
 *
 * Assertions count calls to `refreshClerkCache` and read the key each call was
 * given — never a log line. "Retried once" and "did not retry" are the whole
 * behaviour here, and a test that asserted a warning was logged would pass with
 * the retry deleted.
 *
 * `vi.mock` + `importOriginal` is this package's idiom (`secrets.test.ts`,
 * `github-app-auth-wiring.test.ts`). `refreshClerkCache` is replaced outright
 * rather than wrapped: it would otherwise build a real Clerk client and
 * paginate a real API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshClerkCacheMock, fetchClerkSnapshotMock } = vi.hoisted(() => ({
  refreshClerkCacheMock: vi.fn(),
  fetchClerkSnapshotMock: vi.fn(),
}))

vi.mock('canopycms-auth-clerk/cache-writer', () => ({
  refreshClerkCache: refreshClerkCacheMock,
  fetchClerkSnapshot: fetchClerkSnapshotMock,
}))

import {
  CLERK_ORGANIZATIONS_AS_GROUPS_ENV,
  createClerkAuthCacheRefresher,
  createClerkSnapshotFetcher,
  parseClerkOrganizationsAsGroups,
} from './clerk-refresh'
import type { ReactiveSecret } from './credential-refresh'

/** An error shaped the way `@clerk/backend`'s `ClerkAPIResponseError` is. */
function clerkError(status: number, message = 'Clerk says no'): Error {
  return Object.assign(new Error(message), { status })
}

/**
 * A stand-in for `createReactiveSecret`'s product, so this file tests the
 * refresher's DECISIONS without re-testing the reader's guards (which
 * `credential-refresh.test.ts` covers directly).
 */
function fakeSecret(initial: string | undefined, ...rotations: (string | undefined)[]) {
  let value = initial
  const refresh = vi.fn(async () => {
    const next = rotations.shift()
    if (next !== undefined) value = next
    return next
  })
  return { current: () => value, refresh } satisfies ReactiveSecret
}

/** Every `secretKey` `refreshClerkCache` was called with, in order. */
function keysUsed(): (string | undefined)[] {
  return refreshClerkCacheMock.mock.calls.map(
    (args: unknown[]) => (args[0] as { secretKey?: string }).secretKey,
  )
}

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  refreshClerkCacheMock.mockReset()
  fetchClerkSnapshotMock.mockReset()
  // Swallowed rather than tolerated: `quietTestOutput.onConsoleLog` in
  // vitest.shared.ts THROWS on a write to stdout OR stderr under CI, which
  // leaves a GREEN test count and a non-zero exit. See secrets.test.ts's
  // logSpy.
  //
  // All THREE levels, and `error` is not hypothetical: it was missing when the
  // re-read-failure test below was added, and `CI=1 pnpm exec vitest run`
  // reported every test passed, with exit 1. Locally, where CI is unset, it passed.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

/** Every message a spy captured, flattened — `workerLog*` pass level and text separately. */
function textOf(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n')
}

/** The successful shape `refreshClerkCache` resolves to. */
const ok = { userCount: 3, groupCount: 1, membershipCount: 2 }

describe('no Clerk key configured', () => {
  it('builds no refresher at all', () => {
    // `undefined` is meaningful to CmsWorker: it skips scheduling the
    // auth-cache loop rather than running one that can do nothing.
    expect(
      createClerkAuthCacheRefresher({
        useOrganizationsAsGroups: true,
        secret: fakeSecret(undefined),
        cachePath: '/tmp/cache',
      }),
    ).toBeUndefined()
  })
})

describe('the happy path', () => {
  it('refreshes with the configured key and never touches Secrets Manager', async () => {
    refreshClerkCacheMock.mockResolvedValue(ok)
    const secret = fakeSecret('sk_live_good')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await refresh()

    expect(keysUsed()).toEqual(['sk_live_good'])
    // The steady state: zero GetSecretValue calls for the life of the worker.
    expect(secret.refresh).not.toHaveBeenCalled()
  })

  it('reads the key per call rather than capturing it at construction', async () => {
    refreshClerkCacheMock.mockResolvedValue(ok)
    // The rotation is what makes this test able to fail at all. Built without
    // one, `secret.refresh()` leaves the value alone and "the same key twice"
    // holds whether the key was captured or re-read -- which is how the first
    // version of this test passed with the capture bug reintroduced.
    const secret = fakeSecret('sk_live_first', 'sk_live_second')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await refresh()
    // Something else rotated it -- e.g. the previous tick's retry.
    await secret.refresh()
    expect(secret.current()).toBe('sk_live_second')
    await refresh()

    // A captured key would send 'sk_live_first' twice, which is the exact bug
    // this whole change exists to fix.
    expect(keysUsed()).toEqual(['sk_live_first', 'sk_live_second'])
  })
})

describe('the organizations-as-groups setting', () => {
  it.each([true, false])('reaches refreshClerkCache as %s', async (flag) => {
    refreshClerkCacheMock.mockResolvedValue(ok)
    const refresh = createClerkAuthCacheRefresher({
      secret: fakeSecret('sk_live_good'),
      cachePath: '/tmp/cache',
      useOrganizationsAsGroups: flag,
    })!

    await refresh()

    expect(refreshClerkCacheMock).toHaveBeenCalledWith(
      expect.objectContaining({ useOrganizationsAsGroups: flag }),
    )
  })

  it.each([true, false])('reaches fetchClerkSnapshot as %s', async (flag) => {
    fetchClerkSnapshotMock.mockResolvedValue({ users: [], groups: [], memberships: {} })
    const fetcher = createClerkSnapshotFetcher({
      secret: fakeSecret('sk_live_good'),
      useOrganizationsAsGroups: flag,
    })!

    await fetcher()

    expect(fetchClerkSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ useOrganizationsAsGroups: flag }),
    )
  })
})

describe('parseClerkOrganizationsAsGroups', () => {
  const parse = (value?: string) =>
    parseClerkOrganizationsAsGroups(
      value === undefined ? {} : { [CLERK_ORGANIZATIONS_AS_GROUPS_ENV]: value },
    )

  it('is true when unset or empty', () => {
    expect(parse()).toBe(true)
    expect(parse('')).toBe(true)
  })

  it('reads true and false', () => {
    expect(parse('true')).toBe(true)
    expect(parse('false')).toBe(false)
  })

  it.each(['FALSE', 'False', '0', 'no', ' false', 'yes'])(
    'throws on %j, naming the variable and the value',
    (value) => {
      expect(() => parse(value)).toThrow(CLERK_ORGANIZATIONS_AS_GROUPS_ENV)
      expect(() => parse(value)).toThrow(JSON.stringify(value))
      expect(() => parse(value)).toThrow('true or false')
    },
  )
})

describe('the re-read is gated on the failure looking like a rejected key', () => {
  it.each([500, 502, 429, 408])('does not re-read on a %s', async (status) => {
    refreshClerkCacheMock.mockRejectedValue(clerkError(status))
    const secret = fakeSecret('sk_live_good', 'sk_live_rotated')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await expect(refresh()).rejects.toThrow('Clerk says no')

    // Retrying on a transient failure would re-run the whole workload:
    // every user, every organisation and every membership.
    expect(secret.refresh).not.toHaveBeenCalled()
    expect(refreshClerkCacheMock).toHaveBeenCalledTimes(1)
  })

  it('does not re-read on a status-less failure', async () => {
    refreshClerkCacheMock.mockRejectedValue(new Error('socket hang up'))
    const secret = fakeSecret('sk_live_good', 'sk_live_rotated')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await expect(refresh()).rejects.toThrow('socket hang up')
    expect(secret.refresh).not.toHaveBeenCalled()
  })

  it.each([401, 403])('re-reads and retries once on a %s', async (status) => {
    refreshClerkCacheMock.mockRejectedValueOnce(clerkError(status)).mockResolvedValueOnce(ok)
    const secret = fakeSecret('sk_live_revoked', 'sk_live_rotated')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await expect(refresh()).resolves.toBeUndefined()

    // The retry used the ROTATED key, not the revoked one. Asserting only the
    // call count would pass with the retry re-sending the dead key.
    expect(keysUsed()).toEqual(['sk_live_revoked', 'sk_live_rotated'])
  })
})

describe('the circuit breaker', () => {
  it('rethrows without retrying when the secret has not changed', async () => {
    refreshClerkCacheMock.mockRejectedValue(clerkError(401, 'Unauthenticated'))
    // `refresh()` resolving undefined is how the reader reports every no-op:
    // no ARN, read too recently, or a value identical to the one just refused.
    const secret = fakeSecret('sk_live_wrong')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await expect(refresh()).rejects.toThrow('Unauthenticated')

    expect(secret.refresh).toHaveBeenCalledTimes(1)
    // ONE call. A second would be a guaranteed failure paid for in full.
    expect(refreshClerkCacheMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the Clerk rejection when the re-read ITSELF fails', async () => {
    refreshClerkCacheMock.mockRejectedValue(clerkError(401, 'Unauthenticated'))
    const secret = {
      current: () => 'sk_live_wrong',
      // An IAM policy narrowed after boot is the realistic case.
      refresh: vi.fn(async () => {
        throw new Error('AccessDeniedException')
      }),
    }
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    // The 401 is what explains the stale auth cache. Letting the read failure
    // propagate instead would suppress it on every tick for as long as the IAM
    // condition lasts, since the 15-minute interval always clears the reader's
    // 5-minute floor.
    await expect(refresh()).rejects.toThrow('Unauthenticated')
    expect(refreshClerkCacheMock).toHaveBeenCalledTimes(1)
    // The read failure is not silently dropped either -- it is the only record
    // that the re-read was attempted and could not be made.
    expect(textOf(errorSpy)).toContain('AccessDeniedException')
  })

  it('does not loop when the rotated key is also rejected', async () => {
    refreshClerkCacheMock.mockRejectedValue(clerkError(401, 'still wrong'))
    const secret = fakeSecret('sk_live_wrong', 'sk_live_also_wrong')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    await expect(refresh()).rejects.toThrow('still wrong')

    // Exactly two: the original and one retry. Re-entering the catch would
    // paginate Clerk's entire user list once per rotation, forever.
    expect(refreshClerkCacheMock).toHaveBeenCalledTimes(2)
    expect(secret.refresh).toHaveBeenCalledTimes(1)
  })

  it('bounds the cost across many consecutive failing ticks', async () => {
    refreshClerkCacheMock.mockRejectedValue(clerkError(401))
    // Nothing ever rotates, which is the permanently-wrong-key case.
    const secret = fakeSecret('sk_live_wrong')
    const refresh = createClerkAuthCacheRefresher({
      useOrganizationsAsGroups: true,
      secret,
      cachePath: '/tmp/cache',
    })!

    for (let tick = 0; tick < 20; tick++) {
      await expect(refresh()).rejects.toThrow()
    }

    // One Clerk attempt per tick and one re-read per tick -- never two Clerk
    // attempts per tick, which is what an unguarded retry would cost.
    expect(refreshClerkCacheMock).toHaveBeenCalledTimes(20)
    expect(secret.refresh).toHaveBeenCalledTimes(20)
  })
})

describe('createClerkSnapshotFetcher: the gateway’s half, fetching what the worker writes', () => {
  const snapshot = { users: [], groups: [], memberships: {} }

  /** Every `secretKey` `fetchClerkSnapshot` was called with, in order. */
  const fetchKeys = (): (string | undefined)[] =>
    fetchClerkSnapshotMock.mock.calls.map(
      (args: unknown[]) => (args[0] as { secretKey?: string }).secretKey,
    )

  it('builds no fetcher without a key', () => {
    expect(
      createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret: fakeSecret(undefined) }),
    ).toBeUndefined()
  })

  it('returns the snapshot, fetched with the key and the organisations as groups', async () => {
    fetchClerkSnapshotMock.mockResolvedValue(snapshot)
    const secret = fakeSecret('sk_live_good')
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret })!

    await expect(fetcher()).resolves.toBe(snapshot)

    expect(fetchClerkSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ secretKey: 'sk_live_good', useOrganizationsAsGroups: true }),
    )
    expect(secret.refresh).not.toHaveBeenCalled()
  })

  it('hands its own warn to the fetch, so membership warnings leave through the gateway', async () => {
    fetchClerkSnapshotMock.mockResolvedValue(snapshot)
    const log = { warn: vi.fn(), error: vi.fn() }
    const fetcher = createClerkSnapshotFetcher({
      useOrganizationsAsGroups: true,
      secret: fakeSecret('sk_live_good'),
      log,
    })!

    await fetcher()

    expect(fetchClerkSnapshotMock.mock.calls[0][0].warn).toBe(log.warn)
  })

  it('reads the key per call rather than capturing it', async () => {
    fetchClerkSnapshotMock.mockResolvedValue(snapshot)
    const secret = fakeSecret('sk_live_first', 'sk_live_second')
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret })!

    await fetcher()
    await secret.refresh()
    await fetcher()

    expect(fetchKeys()).toEqual(['sk_live_first', 'sk_live_second'])
  })

  it('throws when the key is gone at call time', async () => {
    const fetcher = createClerkSnapshotFetcher({
      useOrganizationsAsGroups: true,
      secret: {
        current: vi.fn().mockReturnValueOnce('sk_live_good').mockReturnValue(undefined),
        refresh: vi.fn(),
      },
    })!

    await expect(fetcher()).rejects.toThrow('No Clerk secret key is configured')
    expect(fetchClerkSnapshotMock).not.toHaveBeenCalled()
  })

  it.each([401, 403])('retries once with the rotated key on a %s', async (status) => {
    fetchClerkSnapshotMock.mockRejectedValueOnce(clerkError(status)).mockResolvedValueOnce(snapshot)
    const secret = fakeSecret('sk_live_revoked', 'sk_live_rotated')
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret })!

    await expect(fetcher()).resolves.toBe(snapshot)

    expect(fetchKeys()).toEqual(['sk_live_revoked', 'sk_live_rotated'])
  })

  it.each([
    ['a 500', clerkError(500)],
    ['a 404', clerkError(404)],
    ['a network error', new Error('socket hang up')],
  ])('never re-reads on %s', async (_label, failure) => {
    fetchClerkSnapshotMock.mockRejectedValue(failure)
    const secret = fakeSecret('sk_live_good', 'sk_live_rotated')
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret })!

    await expect(fetcher()).rejects.toBe(failure)

    expect(secret.refresh).not.toHaveBeenCalled()
    expect(fetchClerkSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('rethrows the original rejection when the re-read fails, and logs the failure through its own log', async () => {
    const rejection = clerkError(401, 'Unauthenticated')
    fetchClerkSnapshotMock.mockRejectedValue(rejection)
    const log = { warn: vi.fn(), error: vi.fn() }
    const secret = {
      current: () => 'sk_live_wrong',
      refresh: vi.fn(async () => {
        throw new Error('AccessDeniedException')
      }),
    }
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret, log })!

    await expect(fetcher()).rejects.toBe(rejection)

    expect(fetchClerkSnapshotMock).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('AccessDeniedException'),
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('rethrows the original rejection when the re-read answers undefined', async () => {
    const rejection = clerkError(403, 'Forbidden')
    fetchClerkSnapshotMock.mockRejectedValue(rejection)
    const secret = fakeSecret('sk_live_wrong')
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret })!

    await expect(fetcher()).rejects.toBe(rejection)

    expect(secret.refresh).toHaveBeenCalledTimes(1)
    expect(fetchClerkSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a second rejection', async () => {
    fetchClerkSnapshotMock.mockRejectedValue(clerkError(401, 'still wrong'))
    const secret = fakeSecret('sk_live_wrong', 'sk_live_also_wrong')
    const fetcher = createClerkSnapshotFetcher({ useOrganizationsAsGroups: true, secret })!

    await expect(fetcher()).rejects.toThrow('still wrong')

    expect(fetchClerkSnapshotMock).toHaveBeenCalledTimes(2)
    expect(secret.refresh).toHaveBeenCalledTimes(1)
  })

  it('warns of the retry through its own log', async () => {
    fetchClerkSnapshotMock.mockRejectedValueOnce(clerkError(401)).mockResolvedValueOnce(snapshot)
    const log = { warn: vi.fn(), error: vi.fn() }
    const fetcher = createClerkSnapshotFetcher({
      useOrganizationsAsGroups: true,
      secret: fakeSecret('sk_live_revoked', 'sk_live_rotated'),
      log,
    })!

    await fetcher()

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
