import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockConsole, type MockConsole } from '../test-utils'
import {
  formatRequestTimingSummary,
  isRequestTimingScopeActive,
  runWithRequestTiming,
  setRequestTimingRoute,
  timeRequestPhase,
} from './request-timing'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const statusOf = (r: { status: number }) => r.status

describe('request timing', () => {
  let consoleSpy: MockConsole
  let originalDebug: string | undefined

  beforeEach(() => {
    originalDebug = process.env.CANOPYCMS_DEBUG
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    if (originalDebug === undefined) delete process.env.CANOPYCMS_DEBUG
    else process.env.CANOPYCMS_DEBUG = originalDebug
  })

  const timingLines = () => consoleSpy.all().log.filter((l) => l.includes('[CanopyCMS:timing]'))

  it('opens no scope, logs nothing, and still returns the result when debug is off', async () => {
    delete process.env.CANOPYCMS_DEBUG
    let scopeOpened: boolean | undefined
    const result = await runWithRequestTiming(
      'GET',
      async () => {
        scopeOpened = isRequestTimingScopeActive()
        setRequestTimingRoute(':branch/entries')
        return timeRequestPhase('route', async () => ({ status: 200 }))
      },
      statusOf,
    )
    expect(result).toEqual({ status: 200 })
    expect(scopeOpened).toBe(false)
    expect(consoleSpy.all().log).toEqual([])
  })

  it('runs a phase outside any request scope as a plain call', async () => {
    process.env.CANOPYCMS_DEBUG = 'true'
    await expect(timeRequestPhase('settingsRoot', async () => 'root')).resolves.toBe('root')
    expect(timingLines()).toEqual([])
  })

  it('emits one summary line with route, status, nested and repeated phases', async () => {
    process.env.CANOPYCMS_DEBUG = 'true'
    let scopeOpened: boolean | undefined
    await runWithRequestTiming(
      'GET',
      async () => {
        scopeOpened = isRequestTimingScopeActive()
        setRequestTimingRoute(':branch/entries')
        await timeRequestPhase('auth', async () => undefined)
        return timeRequestPhase('route', async () => {
          await timeRequestPhase('settingsRoot', async () => undefined)
          await timeRequestPhase('settingsRoot', async () => undefined)
          return { status: 200 }
        })
      },
      statusOf,
    )

    expect(scopeOpened).toBe(true)
    const lines = timingLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\d{4}-\d\d-\d\dT\S+Z \[CanopyCMS:timing\] \[DEBUG\] GET :branch\/entries 200 \d+ms \| auth=\d+ route=\d+ route>settingsRoot=\d+\(x2\) untimed=\d+/,
    )
  })

  it('keeps concurrent requests apart, even with interleaved same-named phases', async () => {
    process.env.CANOPYCMS_DEBUG = 'true'
    const gateA = deferred()
    const gateB = deferred()

    const request = (route: string, phase: string, gate: Promise<void>) =>
      runWithRequestTiming(
        'GET',
        async () => {
          setRequestTimingRoute(route)
          return timeRequestPhase('route', async () => {
            await timeRequestPhase(phase, () => gate)
            await timeRequestPhase('settingsRoot', async () => undefined)
            return { status: 200 }
          })
        },
        statusOf,
      )

    const a = request('route-a', 'only-a', gateA.promise)
    const b = request('route-b', 'only-b', gateB.promise)
    // B finishes while A is still inside its phase, so a shared timer would be clobbered.
    gateB.resolve()
    await b
    gateA.resolve()
    await a

    const lines = timingLines()
    expect(lines).toHaveLength(2)
    const lineA = lines.find((l) => l.includes(' route-a '))
    const lineB = lines.find((l) => l.includes(' route-b '))
    expect(lineA).toMatch(/route>only-a=\d+ route>settingsRoot=\d+ untimed/)
    expect(lineA).not.toContain('only-b')
    expect(lineA).not.toContain('(x2)')
    expect(lineB).toMatch(/route>only-b=\d+ route>settingsRoot=\d+ untimed/)
    expect(lineB).not.toContain('only-a')
  })

  it('logs a request that throws with status "error" and rethrows', async () => {
    process.env.CANOPYCMS_DEBUG = 'true'
    await expect(
      runWithRequestTiming(
        'POST',
        async () => {
          setRequestTimingRoute('branches')
          return timeRequestPhase('route', async (): Promise<{ status: number }> => {
            throw new Error('boom')
          })
        },
        statusOf,
      ),
    ).rejects.toThrow('boom')
    expect(timingLines()).toEqual([expect.stringMatching(/POST branches error \d+ms \| route=/)])
  })

  it('formats untimed as the total minus top-level phases only', () => {
    const phases = new Map([
      ['user', { count: 1, ms: 300 }],
      ['user>settingsRoot', { count: 1, ms: 290 }],
      ['route', { count: 1, ms: 600 }],
      ['route>settingsRoot', { count: 2, ms: 580.4 }],
    ])
    expect(formatRequestTimingSummary('GET', ':branch/entries', 200, 950, phases)).toBe(
      'GET :branch/entries 200 950ms | user=300 user>settingsRoot=290 route=600 route>settingsRoot=580(x2) untimed=50',
    )
  })
})
