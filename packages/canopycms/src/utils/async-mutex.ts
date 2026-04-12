/**
 * FIFO per-key async mutex.
 *
 * Module-level map so all callers within the same process share the same set of locks.
 * Lock key = absolute file path (or any string that uniquely identifies the resource).
 *
 * Each caller atomically enqueues itself behind the current tail and only ever wakes
 * once — guaranteeing strict FIFO order with no thundering-herd on release.
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
