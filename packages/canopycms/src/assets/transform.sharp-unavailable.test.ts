/**
 * Isolated from transform.test.ts for the reason pipeline.sharp-unavailable.test.ts
 * is isolated from pipeline.test.ts: it mocks the 'sharp' module itself to
 * simulate a native binary that cannot load (a libvips `.so` missing from the
 * deployment), and transform.test.ts's fixtures need the real thing.
 *
 * `vi.resetModules()` before each test is load-bearing. `loadSharp()`
 * memoizes its result, rejection included, in module state, so without a
 * fresh module registry a later test would inherit an earlier test's
 * already-rejected promise and log nothing - and the "exactly one error"
 * assertion would pass or fail depending on test order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockConsole, type MockConsole } from '../test-utils/console-spy'
import type { TransformDirectives } from './transform-directives'

vi.mock('sharp', () => {
  throw new Error('Could not load the "sharp" module using the linux-arm64 runtime')
})

const IDENTITY: TransformDirectives = { identity: true }

/** Never decoded: every test here fails before sharp would see the bytes. */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Every message down an error's `cause` chain. Vitest wraps an error thrown by
 * a `vi.mock` factory in its own "error when mocking a module" Error and keeps
 * the original as `cause`, so the simulated load failure is one level down.
 */
function messagesInCauseChain(err: unknown): string[] {
  const messages: string[] = []
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    messages.push(current.message)
  }
  return messages
}

describe('applyTransform - sharp unavailable', () => {
  let consoleSpy: MockConsole

  beforeEach(() => {
    vi.resetModules()
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  it('imports without loading sharp', async () => {
    const transform = await import('./transform')

    expect(transform.applyTransform).toBeTypeOf('function')
    expect(consoleSpy.all().error).toEqual([])
  })

  it('still answers 400 for an unsupported input format, without trying to load sharp', async () => {
    const { applyTransform } = await import('./transform')

    const result = await applyTransform({ data: PNG_MAGIC, ext: 'svg' }, IDENTITY)

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Unsupported input format for transform: 'svg'",
    })
    expect(consoleSpy.all().error).toEqual([])
  })

  it('rejects a raster transform with the load error instead of resolving a 422', async () => {
    const { applyTransform } = await import('./transform')

    const error = await applyTransform({ data: PNG_MAGIC, ext: 'png' }, IDENTITY).then(
      (result) => {
        throw new Error(`expected a rejection, got ${JSON.stringify(result)}`)
      },
      (err: unknown) => err,
    )

    expect(messagesInCauseChain(error)).toContainEqual(
      expect.stringMatching(/Could not load the "sharp" module/),
    )
  })

  it('logs the load failure exactly once across repeated transforms', async () => {
    const { applyTransform } = await import('./transform')

    await expect(applyTransform({ data: PNG_MAGIC, ext: 'png' }, IDENTITY)).rejects.toThrow()
    await expect(applyTransform({ data: PNG_MAGIC, ext: 'jpg' }, IDENTITY)).rejects.toThrow()

    const errors = consoleSpy.all().error
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(
      /sharp failed to load - image transforms and upload decode validation/,
    )
  })
})
