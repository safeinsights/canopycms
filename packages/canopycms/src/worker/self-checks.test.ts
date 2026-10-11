import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertSelfChecks,
  coreLimitZero,
  corePatternNotPiped,
  efsUnreadable,
  gatewaySelfChecks,
  homeIsEmpty,
  imdsUnreachable,
  noSecretsInEnv,
  onlyLoopback,
  procShowsOnlyOwnProcesses,
  tcpConnect,
  workerSelfChecks,
  type ConnectOutcome,
} from './self-checks'

let root: string
const uid = process.getuid?.() ?? 0

/** Write `content` at `relative` under the fake root. */
async function put(relative: string, content: string): Promise<void> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

const NET_DEV_HEADER =
  'Inter-|   Receive                                                |  Transmit\n' +
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n'
const LIMITS = (soft: string, hard: string) =>
  'Limit                     Soft Limit           Hard Limit           Units     \n' +
  `Max cpu time              unlimited            unlimited            seconds   \n` +
  `Max core file size        ${soft.padEnd(20)} ${hard.padEnd(20)} bytes     \n`

/** A tree on which every check passes. */
async function healthyTree(): Promise<void> {
  await put('proc/self/net/dev', `${NET_DEV_HEADER}    lo: 0 0 0 0 0 0 0 0 0 0\n`)
  await fs.mkdir(path.join(root, 'proc', '4242'), { recursive: true })
  await fs.mkdir(path.join(root, 'home'), { recursive: true })
  await put('proc/sys/kernel/core_pattern', 'core\n')
  await put('proc/self/limits', LIMITS('0', '0'))
}

const connected = async (): Promise<ConnectOutcome> => 'connected'

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-self-checks-'))
})

afterEach(async () => {
  await fs.chmod(path.join(root, 'mnt', 'efs'), 0o700).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
})

describe('the IMDS check', () => {
  it.each([
    ['no route', { code: 'ENETUNREACH' }],
    ['no IPv4 sockets at all', { code: 'EAFNOSUPPORT' }],
    ['a timeout', 'timeout'],
  ] as const)('passes on %s', async (_, outcome) => {
    const result = await imdsUnreachable({ connect: async () => outcome })

    expect(result.ok).toBe(true)
  })

  it.each([
    ['a connection', 'connected'],
    ['a refusal, which means a route', { code: 'ECONNREFUSED' }],
    ['any other failure', { code: 'EHOSTUNREACH' }],
  ] as const)('refuses on %s', async (_, outcome) => {
    const result = await imdsUnreachable({ connect: async () => outcome })

    expect(result).toMatchObject({ check: 'imds', ok: false })
    expect(result.detail).toMatch(/can reach the instance metadata service/)
  })

  it('connects to 169.254.169.254:80 with a one-second bound', async () => {
    const calls: unknown[] = []

    await imdsUnreachable({
      connect: async (...args) => {
        calls.push(args)
        return 'timeout'
      },
    })

    expect(calls).toEqual([['169.254.169.254', 80, 1_000]])
  })

  it("reads a real connect's outcome: connected, or refused with its code", async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const listening = net.createServer()
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    try {
      const open = (listening.address() as net.AddressInfo).port

      expect(await tcpConnect('127.0.0.1', open, 1_000)).toBe('connected')
      expect(await tcpConnect('127.0.0.1', port, 1_000)).toEqual({ code: 'ECONNREFUSED' })
    } finally {
      await new Promise<void>((resolve) => listening.close(() => resolve()))
    }
  })
})

describe('the network namespace check', () => {
  it('passes when /proc/self/net/dev lists only lo', async () => {
    await put('proc/self/net/dev', `${NET_DEV_HEADER}    lo: 0 0 0 0 0 0 0 0 0 0\n`)

    expect((await onlyLoopback({ root })).ok).toBe(true)
  })

  it('refuses another interface', async () => {
    await put('proc/self/net/dev', `${NET_DEV_HEADER}    lo: 0 0 0 0\n  ens5: 1 2 3 4\n`)

    const result = await onlyLoopback({ root })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('ens5')
  })

  it('refuses when it cannot read the file', async () => {
    expect((await onlyLoopback({ root })).ok).toBe(false)
  })
})

describe('the /proc check', () => {
  it("passes when every listed process is this uid's", async () => {
    await fs.mkdir(path.join(root, 'proc', '17'), { recursive: true })
    await fs.mkdir(path.join(root, 'proc', 'self'), { recursive: true })

    expect((await procShowsOnlyOwnProcesses({ root, uid })).ok).toBe(true)
  })

  it("refuses another user's process", async () => {
    await fs.mkdir(path.join(root, 'proc', '17'), { recursive: true })

    const result = await procShowsOnlyOwnProcesses({ root, uid: uid + 1 })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('17')
  })

  it('refuses when it cannot list /proc', async () => {
    expect((await procShowsOnlyOwnProcesses({ root, uid })).ok).toBe(false)
  })
})

describe('the /home check', () => {
  it('passes on an empty /home', async () => {
    await fs.mkdir(path.join(root, 'home'))

    expect((await homeIsEmpty({ root })).ok).toBe(true)
  })

  it('refuses a /home with entries, and a missing one', async () => {
    expect((await homeIsEmpty({ root })).ok).toBe(false)
    await fs.mkdir(path.join(root, 'home', 'ec2-user'), { recursive: true })
    expect((await homeIsEmpty({ root })).ok).toBe(false)
  })
})

describe('the secrets check', () => {
  it.each([
    'CANOPYCMS_GITHUB_TOKEN',
    'CANOPYCMS_GITHUB_TOKEN_SECRET_ARN',
    'CANOPYCMS_GITHUB_APP_PRIVATE_KEY',
    'CANOPYCMS_GITHUB_APP_ID',
    'CLERK_SECRET_KEY',
    'CLERK_SECRET_KEY_SECRET_ARN',
  ])('refuses %s, naming it and never its value', (name) => {
    const result = noSecretsInEnv({ env: { PATH: '/usr/bin', [name]: 'v4lue-never-shown' } })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain(name)
    expect(result.detail).not.toContain('v4lue-never-shown')
  })

  it.each([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITHUB_BOT_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
  ])('refuses the ambient credential %s, naming it and never its value', (name) => {
    const result = noSecretsInEnv({ env: { PATH: '/usr/bin', [name]: 'v4lue-never-shown' } })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain(name)
    expect(result.detail).not.toContain('v4lue-never-shown')
  })

  it.each(['GITHUB_TOKEN_PATH', 'MY_GH_TOKEN', 'AWS_REGION', 'CLERK_JWT_KEY'])(
    'passes the lookalike %s',
    (name) => {
      expect(noSecretsInEnv({ env: { PATH: '/usr/bin', [name]: 'value' } }).ok).toBe(true)
    },
  )

  it('passes with none, and ignores lookalikes', () => {
    expect(
      noSecretsInEnv({ env: { PATH: '/usr/bin', CANOPYCMS_GITHUB_GATEWAY_SOCKET: '/run/x' } }).ok,
    ).toBe(true)
  })
})

describe('the gateway checks', () => {
  it('pass when /mnt/efs cannot be read, cores are not piped, and the core limit is zero', async () => {
    await healthyTree()
    await fs.mkdir(path.join(root, 'mnt', 'efs'), { recursive: true })
    await fs.chmod(path.join(root, 'mnt', 'efs'), 0o000)

    const results = await gatewaySelfChecks({ root })

    expect(results.map((result) => [result.check, result.ok])).toEqual([
      ['efs-unreadable', true],
      ['core-pattern', true],
      ['core-limit', true],
    ])
  })

  it('refuse a readable /mnt/efs', async () => {
    await fs.mkdir(path.join(root, 'mnt', 'efs'), { recursive: true })

    expect((await efsUnreadable({ root })).ok).toBe(false)
  })

  it('refuse a missing /mnt/efs: only a denial proves the directive took effect', async () => {
    const result = await efsUnreadable({ root })

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/cannot tell/)
  })

  it('refuse a piped core_pattern, and an unreadable one', async () => {
    expect((await corePatternNotPiped({ root })).ok).toBe(false)
    await put('proc/sys/kernel/core_pattern', '|/usr/lib/systemd/systemd-coredump %P\n')
    expect((await corePatternNotPiped({ root })).ok).toBe(false)
  })

  it.each([
    ['unlimited', 'unlimited'],
    ['0', 'unlimited'],
    ['1024', '0'],
  ])('refuse a core limit of %s soft and %s hard', async (soft, hard) => {
    await put('proc/self/limits', LIMITS(soft, hard))

    expect((await coreLimitZero({ root })).ok).toBe(false)
  })
})

describe('all together', () => {
  it("run the worker's checks in the plan's order, and pass on a healthy tree", async () => {
    await healthyTree()

    const results = await workerSelfChecks({
      root,
      uid,
      env: { PATH: '/usr/bin' },
      connect: async () => ({ code: 'ENETUNREACH' }),
    })

    expect(results.map((result) => [result.check, result.ok])).toEqual([
      ['imds', true],
      ['network-namespace', true],
      ['proc', true],
      ['home', true],
      ['secrets-in-env', true],
    ])
    expect(() => assertSelfChecks(results)).not.toThrow()
  })

  it('refuse to start, naming every failed check', async () => {
    await healthyTree()
    const results = await workerSelfChecks({
      root,
      uid,
      env: { CLERK_SECRET_KEY: 'x' },
      connect: connected,
    })

    expect(() => assertSelfChecks(results)).toThrow(/imds: .*; secrets-in-env: /)
  })
})
