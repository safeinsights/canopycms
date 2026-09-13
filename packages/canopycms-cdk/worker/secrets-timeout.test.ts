/**
 * Regression tests for `secretsManagerClientConfig`, against the REAL
 * `@aws-sdk/client-secrets-manager` — deliberately NOT `vi.mock`, unlike
 * `secrets.test.ts`. Mocking the client module would make it impossible to
 * observe what the real `NodeHttpHandler` does with the timeout options this
 * function sets, which is the entire point of these tests: prove the bound is
 * real, not merely present in the config object.
 *
 * The measurements behind the chosen defaults (3000ms connection / 15000ms
 * request+socket) live in the comment above `secretsManagerClientConfig` in
 * `secrets.ts`. These tests use much shorter timeouts so the suite stays fast;
 * only the wiring is under test here, not the production values.
 */

import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { secretsManagerClientConfig } from './secrets'

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
