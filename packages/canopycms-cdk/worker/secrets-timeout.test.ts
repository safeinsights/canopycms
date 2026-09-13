/**
 * Regression tests for the Secrets Manager timeout/deadline machinery,
 * against the REAL `@aws-sdk/client-secrets-manager` — deliberately NOT
 * `vi.mock`, unlike `secrets.test.ts`. Mocking the client module would make
 * it impossible to observe what the real `NodeHttpHandler` does with the
 * timeout options this function sets, which is the entire point of these
 * tests: prove the bounds are real, not merely present in a config object.
 *
 * Two branches of `@smithy/node-http-handler@4.5.0`'s `setSocketTimeout`
 * (dist-cjs/index.js) are exercised deliberately, by different tests:
 *   - The first two tests below (unchanged from before the body-stall
 *     defect) use `requestTimeout: 1000` (< 6000), which makes
 *     `socketTimeout` arm IMMEDIATELY — the simple branch. It says nothing
 *     about a stalled response BODY: these tests never let response headers
 *     arrive at all, so `requestTimeout`/`socketTimeout` alone bound them.
 *   - Every test after that uses the PRODUCTION `requestTimeout`/
 *     `socketTimeout` of 15000ms (>= 6000), which makes `setSocketTimeout`
 *     DEFER arming the socket idle timer by 3000ms behind a timer that gets
 *     cleared the instant response headers arrive. That deferred-arm branch
 *     is the one a stalled response BODY slipped through — see the
 *     measurement in the comment above `secretsManagerClientConfig` in
 *     `secrets.ts`. Those tests inject a SHORT deadline (well under the
 *     15000ms production value) so the suite stays fast while still
 *     exercising the real, slow branch:
 *       - the "stalled RESPONSE BODY" tests below drive a real
 *         `SecretsManagerClient` + `AbortSignal.timeout(...)` directly —
 *         the MECHANISM `fetchSecretString` uses, in isolation;
 *       - the "getSecret() wiring" test drives `getSecret` itself, so it
 *         pins that the mechanism is actually wired into `fetchSecretString`
 *         for every attempt, not just available as an unused helper.
 */

import net from 'node:net'
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { getSecret, secretsManagerClientConfig } from './secrets'

/**
 * A TCP server that accepts every connection and then writes nothing, ever —
 * the shape of a stalled endpoint (up, but not responding), as opposed to a
 * refused or unroutable one. Sockets are tracked and force-destroyed on
 * `close()` so the server can shut down without waiting for a client this test
 * deliberately never lets finish on its own.
 */
function startBlackholeServer(): Promise<{
  port: number
  connectionCount: () => number
  close: () => Promise<void>
}> {
  let connectionCount = 0
  const sockets = new Set<import('node:net').Socket>()
  const server = net.createServer((socket) => {
    connectionCount++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {}) // swallow ECONNRESET from the client side
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound TCP address')
      }
      resolve({
        port: address.port,
        connectionCount: () => connectionCount,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
            for (const s of sockets) s.destroy()
          }),
      })
    })
  })
}

/**
 * Shapes of a stalled response BODY — headers arrive normally (a live,
 * routable, responding endpoint), and then the body does one of:
 *   'headers-then-silence' — 10 body bytes, then nothing, ever
 *   'headers-only'         — no body bytes at all, ever (headers flushed)
 *   'headers-then-trickle' — one body byte every 2s, forever
 * These are the three shapes measured in the comment above
 * `secretsManagerClientConfig`, all found to hang indefinitely under the
 * production requestHandler options alone.
 */
type BodyStallBehavior = 'headers-then-silence' | 'headers-only' | 'headers-then-trickle'

/**
 * An HTTP server producing one `BodyStallBehavior`. Sockets are tracked and
 * force-destroyed on `close()`, same reasoning as `startBlackholeServer`.
 */
function startBodyStallServer(behavior: BodyStallBehavior): Promise<{
  port: number
  openSocketCount: () => number
  requestCount: () => number
  close: () => Promise<void>
}> {
  const sockets = new Set<import('node:net').Socket>()
  let trickle: NodeJS.Timeout | undefined
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    if (behavior === 'headers-then-silence') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write(Buffer.alloc(10, 'x')) // 10 body bytes, then stall forever
    } else if (behavior === 'headers-only') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders() // headers only, then stall forever
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      trickle = setInterval(() => res.write('a'), 2000)
      res.on('close', () => trickle && clearInterval(trickle))
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound TCP address')
      }
      resolve({
        port: address.port,
        openSocketCount: () => sockets.size,
        requestCount: () => requests,
        close: () =>
          new Promise<void>((r) => {
            if (trickle) clearInterval(trickle)
            server.close(() => r())
            for (const s of sockets) s.destroy()
          }),
      })
    })
  })
}

let activeServer: { close: () => Promise<void> } | undefined

afterEach(async () => {
  await activeServer?.close()
  activeServer = undefined
})

describe('secretsManagerClientConfig against a real SecretsManagerClient', () => {
  it('rejects a stalled request within the configured bound, instead of hanging', async () => {
    const server = await startBlackholeServer()
    activeServer = server

    const client = new SecretsManagerClient({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      ...secretsManagerClientConfig({ connectionTimeout: 300, requestTimeout: 1000 }),
    })

    const start = Date.now()
    await expect(client.send(new GetSecretValueCommand({ SecretId: 'test' }))).rejects.toThrow()
    const elapsed = Date.now() - start

    // Configured requestTimeout is 1000ms; bounded well under vitest's default
    // testTimeout so a regression back to "no timeout armed" is reported as a
    // slow/red test rather than the suite silently hanging.
    expect(elapsed).toBeLessThan(3000)

    client.destroy()
  })

  it('makes exactly one connection for one failing send, via maxAttempts: 1', async () => {
    const server = await startBlackholeServer()
    activeServer = server

    const client = new SecretsManagerClient({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      ...secretsManagerClientConfig({ connectionTimeout: 300, requestTimeout: 500 }),
    })

    await expect(client.send(new GetSecretValueCommand({ SecretId: 'test' }))).rejects.toThrow()

    // Without `maxAttempts: 1`, the SDK's own default retry policy (measured
    // separately at `maxAttempts: 3`, standard retry mode) would have retried
    // this failure on its own, multiplying every attempt `fetchSecretString`'s
    // retry loop already makes.
    expect(server.connectionCount()).toBe(1)

    client.destroy()
  })
})

describe('a stalled response BODY, under production requestTimeout/socketTimeout (the deferred-arm branch)', () => {
  it.each([
    ['headers, 10 body bytes, then silence', 'headers-then-silence'],
    ['headers only, body withheld entirely', 'headers-only'],
    ['headers, then one body byte every 2s', 'headers-then-trickle'],
  ] as const)('rejects within the injected deadline when %s', async (_label, behavior) => {
    const server = await startBodyStallServer(behavior)
    activeServer = server

    const client = new SecretsManagerClient({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      // PRODUCTION connectionTimeout/requestTimeout/socketTimeout (3000/15000/15000)
      // — deliberately NOT overridden, so this exercises the >= 6000ms
      // deferred-arm branch of `setSocketTimeout`, unlike the two tests above.
      ...secretsManagerClientConfig(),
    })

    const start = Date.now()
    await expect(
      client.send(new GetSecretValueCommand({ SecretId: 'test' }), {
        // The SHORT injected deadline — the same mechanism `fetchSecretString`
        // applies per attempt. Far below the 15000ms production
        // requestTimeout/socketTimeout, so only this can explain a fast
        // rejection.
        abortSignal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow()
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(3000)

    // The abort must also clean up: no dangling server-side socket left half
    // read after the client gives up.
    await new Promise((r) => setTimeout(r, 200))
    expect(server.openSocketCount()).toBe(0)

    client.destroy()
  })
})

describe('getSecret() wiring', () => {
  it("bounds a real getSecret() call when the endpoint's response body stalls", async () => {
    const server = await startBodyStallServer('headers-only')
    activeServer = server

    const prevEndpoint = process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER
    const prevRegion = process.env.AWS_REGION
    const prevAccessKeyId = process.env.AWS_ACCESS_KEY_ID
    const prevSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    const prevProfile = process.env.AWS_PROFILE

    // `AWS_ENDPOINT_URL_<SERVICE>` is honoured by the installed
    // `@aws-sdk/client-secrets-manager@3.1018.0` with no explicit `endpoint`
    // option — verified directly against this SDK version before relying on
    // it here (constructing a bare `new SecretsManagerClient({})` with only
    // env vars set reached a local server). `getSecret` takes no endpoint
    // option itself, so this is the only way to point its internally
    // constructed client at the local server.
    process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = `http://127.0.0.1:${server.port}`
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'x'
    process.env.AWS_SECRET_ACCESS_KEY = 'y'
    // An ambient AWS_PROFILE makes the SDK's credential chain skip the keys
    // above and fail before any request is sent -- fast, and a rejection, so
    // the assertions below would mistake it for the deadline working.
    delete process.env.AWS_PROFILE

    try {
      const start = Date.now()
      await expect(
        getSecret('arn:aws:secretsmanager:us-east-1:123456789012:secret:test-XXXXXX', {
          retries: 0, // exactly one attempt, no backoff — isolates the deadline itself
          attemptTimeoutMs: 1000, // short injected deadline, far below the 15000ms production default
        }),
      ).rejects.toThrow(/aborted/)
      // Without the deadline wired into `fetchSecretString`'s `client.send`,
      // this headers-only response hangs forever: once headers have arrived,
      // neither the request timeout nor the socket timeout fires.
      expect(Date.now() - start).toBeLessThan(3000)
      // The request really reached the stalled server. Any failure BEFORE a
      // request is sent -- credentials, endpoint resolution -- is also fast and
      // also rejects, so without this the test passes with the deadline gone.
      expect(server.requestCount()).toBe(1)
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      restore('AWS_ENDPOINT_URL_SECRETS_MANAGER', prevEndpoint)
      restore('AWS_REGION', prevRegion)
      restore('AWS_ACCESS_KEY_ID', prevAccessKeyId)
      restore('AWS_SECRET_ACCESS_KEY', prevSecretAccessKey)
      restore('AWS_PROFILE', prevProfile)
    }
  })
})

describe('getSecret() attemptTimeoutMs validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1])(
    'rejects attemptTimeoutMs %s before any request, naming the option',
    async (attemptTimeoutMs) => {
      const start = Date.now()
      await expect(
        getSecret('arn:aws:secretsmanager:us-east-1:123456789012:secret:test-XXXXXX', {
          retries: 3,
          attemptTimeoutMs,
        }),
      ).rejects.toThrow(/attemptTimeoutMs must be a whole number/)
      // Unvalidated, AbortSignal.timeout threw inside the retry loop's try, so
      // this backed off for ~7s and then rejected with a RangeError.
      expect(Date.now() - start).toBeLessThan(1000)
    },
  )
})
