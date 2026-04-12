import { describe, it, expect, vi } from 'vitest'
import { withLock } from './async-mutex'

describe('withLock', () => {
  it('runs a single call immediately', async () => {
    const result = await withLock('k', async () => 42)
    expect(result).toBe(42)
  })

  it('serializes concurrent calls on the same key in FIFO order', async () => {
    const order: number[] = []
    let resolveFirst!: () => void

    const first = withLock('k', () =>
      new Promise<void>((r) => {
        resolveFirst = r
      }).then(() => {
        order.push(1)
      }),
    )
    const second = withLock('k', async () => {
      order.push(2)
    })

    // Tick once: second is enqueued behind first but first hasn't resolved yet
    await Promise.resolve()
    expect(order).toEqual([])

    resolveFirst()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  it('runs concurrent calls on different keys in parallel', async () => {
    const order: number[] = []
    let resolveA!: () => void
    let resolveB!: () => void

    const a = withLock('a', () =>
      new Promise<void>((r) => {
        resolveA = r
      }).then(() => {
        order.push(1)
      }),
    )
    const b = withLock('b', () =>
      new Promise<void>((r) => {
        resolveB = r
      }).then(() => {
        order.push(2)
      }),
    )

    await Promise.resolve()
    // Both locks started (different keys — no waiting)
    resolveB()
    resolveA()
    await Promise.all([a, b])
    expect(order).toEqual([2, 1]) // b resolved first
  })

  it('releases the lock even when fn throws', async () => {
    const err = new Error('boom')
    await expect(
      withLock('k', async () => {
        throw err
      }),
    ).rejects.toThrow('boom')

    // Lock must be released — subsequent call should run without hanging
    const result = await withLock('k', async () => 'ok')
    expect(result).toBe('ok')
  })

  it('cleans up the map entry when no waiters remain', async () => {
    // After a single call the map should be empty (no leak)
    await withLock('cleanup-key', async () => {})
    // We can't inspect the private map directly, but we can verify no hang on re-entry
    await withLock('cleanup-key', async () => {})
  })

  it('serializes three concurrent calls in submission order', async () => {
    const order: number[] = []
    const resolvers: Array<() => void> = []

    const tasks = [1, 2, 3].map((n) =>
      withLock('k3', () =>
        new Promise<void>((r) => {
          resolvers.push(r)
        }).then(() => {
          order.push(n)
        }),
      ),
    )

    // Drain the microtask queue until the first resolver has been registered
    // (fn1 starts immediately since no prior lock; fn2 and fn3 are queued behind it)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(resolvers).toHaveLength(1)

    // Resolve fn1; drain until fn2 registers its resolver
    resolvers[0]()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(resolvers).toHaveLength(2)

    // Resolve fn2; drain until fn3 registers its resolver
    resolvers[1]()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(resolvers).toHaveLength(3)

    resolvers[2]()
    await Promise.all(tasks)
    expect(order).toEqual([1, 2, 3])
  })

  it('returns the value from fn', async () => {
    const val = await withLock('ret', async () => ({ x: 7 }))
    expect(val).toEqual({ x: 7 })
  })

  it('handles concurrent callers where fn is a spy', async () => {
    const fn = vi.fn().mockResolvedValue('done')
    await Promise.all([withLock('spy', fn), withLock('spy', fn), withLock('spy', fn)])
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
