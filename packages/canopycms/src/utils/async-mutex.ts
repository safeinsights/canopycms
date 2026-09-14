/**
 * FIFO per-key async mutex, keyed by any string that uniquely identifies the resource (usually
 * an absolute file path). Module-level, so it serializes only within one process.
 *
 * Each caller atomically enqueues itself behind the current tail and wakes exactly once: strict
 * FIFO order, no thundering herd on release.
 */
const locks = new Map<string, Promise<void>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  locks.set(key, next)
  await prev
  try {
    return await fn()
  } finally {
    resolve()
    if (locks.get(key) === next) locks.delete(key)
  }
}
