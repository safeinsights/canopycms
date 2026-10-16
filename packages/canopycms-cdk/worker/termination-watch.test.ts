/**
 * The worker's termination watch and its lifecycle-hook completion, against a
 * fake instance-metadata service and a fake Auto Scaling client. The commands
 * sent are the SDK's real ones, so their serialized input is what is asserted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CompleteLifecycleActionCommand,
  DescribeAutoScalingInstancesCommand,
  type AutoScalingClient,
} from '@aws-sdk/client-auto-scaling'

import { completeTerminationLifecycleAction, watchForTermination } from './termination-watch'
import { WORKER_DRAIN_HOOK_NAME } from '../src/constructs/worker-lifecycle'

const ENDPOINT = 'http://imds.test'

type MetadataAnswer = { status: number; body?: string } | Error

/**
 * A fake IMDSv2: hands out a token, and answers each metadata path from a
 * queue (the last answer repeats). Records every request.
 */
function fakeImds(answers: Record<string, MetadataAnswer[]>) {
  const requests: Array<{ method: string; path: string; token?: string }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      token: headers.get('X-aws-ec2-metadata-token') ?? undefined,
    })
    if (url.pathname === '/latest/api/token') return new Response('tok-1', { status: 200 })
    const metadataPath = url.pathname.replace('/latest/meta-data/', '')
    const queue = answers[metadataPath] ?? [{ status: 404 }]
    const answer = queue.length > 1 ? queue.shift()! : queue[0]
    if (answer instanceof Error) throw answer
    return new Response(answer.body ?? '', { status: answer.status })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests }
}

/** A sleep that never resolves after `polls` calls, so a watch that should not fire stops. */
function countingSleep(polls: number) {
  let calls = 0
  return {
    sleep: () => (++calls >= polls ? new Promise<void>(() => {}) : Promise.resolve()),
    calls: () => calls,
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.flat().join(' ')

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('watchForTermination', () => {
  it('resolves once Auto Scaling targets the instance for termination, reading through IMDSv2', async () => {
    const { fetchImpl, requests } = fakeImds({
      'autoscaling/target-lifecycle-state': [
        { status: 200, body: 'InService' },
        { status: 200, body: 'Terminated' },
      ],
    })

    const notice = await watchForTermination({
      watchSpot: false,
      imdsEndpoint: ENDPOINT,
      fetchImpl,
      sleep: async () => {},
    })

    expect(notice.kind).toBe('auto-scaling')
    const reads = requests.filter((r) => r.path.startsWith('/latest/meta-data/'))
    expect(reads).toHaveLength(2)
    expect(reads.every((r) => r.token === 'tok-1')).toBe(true)
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2)
  })

  it('never reads the spot notice on on-demand capacity', async () => {
    const { fetchImpl, requests } = fakeImds({
      'autoscaling/target-lifecycle-state': [{ status: 200, body: 'InService' }],
      'spot/instance-action': [{ status: 200, body: '{"action":"terminate"}' }],
    })
    const sleep = countingSleep(3)

    void watchForTermination({
      watchSpot: false,
      imdsEndpoint: ENDPOINT,
      fetchImpl,
      sleep: sleep.sleep,
    })
    await vi.waitFor(() => expect(sleep.calls()).toBe(3))

    expect(requests.some((r) => r.path.includes('spot'))).toBe(false)
  })

  it('resolves on a spot interruption notice when watching spot', async () => {
    const { fetchImpl } = fakeImds({
      'autoscaling/target-lifecycle-state': [{ status: 200, body: 'InService' }],
      'spot/instance-action': [
        { status: 404 },
        { status: 200, body: '{"action":"terminate","time":"2026-10-09T12:00:00Z"}' },
      ],
    })

    const notice = await watchForTermination({
      watchSpot: true,
      imdsEndpoint: ENDPOINT,
      fetchImpl,
      sleep: async () => {},
    })

    expect(notice.kind).toBe('spot')
    expect(notice.reason).toContain('"action":"terminate"')
  })

  it('keeps polling through unreachable metadata, warning once, and still sees the termination', async () => {
    const { fetchImpl } = fakeImds({
      'autoscaling/target-lifecycle-state': [
        new Error('connect ETIMEDOUT'),
        new Error('connect ETIMEDOUT'),
        { status: 404 },
        { status: 200, body: 'Terminated' },
      ],
    })

    const notice = await watchForTermination({
      watchSpot: false,
      imdsEndpoint: ENDPOINT,
      fetchImpl,
      sleep: async () => {},
    })

    expect(notice.kind).toBe('auto-scaling')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(logged(warnSpy)).toContain('Cannot read instance metadata')
    expect(logged(logSpy)).toContain('Instance metadata reachable again')
  })
})

describe('completeTerminationLifecycleAction', () => {
  /** The SDK's overloaded `send` is not assignable from a plain spy. */
  const asClient = (send: ReturnType<typeof vi.fn>) =>
    ({ send }) as unknown as Pick<AutoScalingClient, 'send'>
  const metadata = () =>
    fakeImds({ 'instance-id': [{ status: 200, body: 'i-0123456789abcdef0' }] }).fetchImpl

  it("completes the drain hook with CONTINUE on the instance's own group", async () => {
    const send = vi.fn(async (command: unknown) =>
      command instanceof DescribeAutoScalingInstancesCommand
        ? { AutoScalingInstances: [{ AutoScalingGroupName: 'stack-WorkerAsg-ABC' }] }
        : {},
    )

    await completeTerminationLifecycleAction({
      client: asClient(send),
      imdsEndpoint: ENDPOINT,
      fetchImpl: metadata(),
    })

    const [describe, complete] = send.mock.calls.map(([command]) => command)
    expect(describe).toBeInstanceOf(DescribeAutoScalingInstancesCommand)
    expect((describe as DescribeAutoScalingInstancesCommand).input).toEqual({
      InstanceIds: ['i-0123456789abcdef0'],
    })
    expect(complete).toBeInstanceOf(CompleteLifecycleActionCommand)
    expect((complete as CompleteLifecycleActionCommand).input).toEqual({
      AutoScalingGroupName: 'stack-WorkerAsg-ABC',
      LifecycleHookName: WORKER_DRAIN_HOOK_NAME,
      InstanceId: 'i-0123456789abcdef0',
      LifecycleActionResult: 'CONTINUE',
    })
  })

  it('logs and returns, never throws, when the instance is in no group', async () => {
    const send = vi.fn(async () => ({ AutoScalingInstances: [] }))

    await expect(
      completeTerminationLifecycleAction({
        client: asClient(send),
        imdsEndpoint: ENDPOINT,
        fetchImpl: metadata(),
      }),
    ).resolves.toBeUndefined()

    expect(send).toHaveBeenCalledTimes(1)
    expect(logged(errorSpy)).toContain('not in an Auto Scaling group')
    expect(logged(errorSpy)).toContain('heartbeat times out')
  })

  it('logs and returns, never throws, when the API refuses', async () => {
    const send = vi.fn(async () => {
      throw new Error('AccessDenied')
    })

    await expect(
      completeTerminationLifecycleAction({
        client: asClient(send),
        imdsEndpoint: ENDPOINT,
        fetchImpl: metadata(),
      }),
    ).resolves.toBeUndefined()
    expect(logged(errorSpy)).toContain('AccessDenied')
  })
})
