/** Session-history writes stamped with their position, so a refused Back can be undone. */
const STAMP_KEY = 'canopyHistory'
// Next.js's patched history methods add these back and record the URL, unless already present.
const ROUTER_KEYS = ['__NA', '__PRIVATE_NEXTJS_INTERNALS_TREE', '_N']

interface Stamp {
  run: string
  position: number
}

// A run restarts wherever the position is lost, so positions from two runs are never compared.
let run = ''
let position: number | undefined
let undoTarget: Stamp | undefined

const newRun = () => {
  run = Math.random().toString(36).slice(2)
  position = undefined
}

const currentState = (): Record<string, unknown> => {
  const state: unknown = window.history.state
  return state !== null && typeof state === 'object' ? { ...state } : {}
}

const stampIn = (state: Record<string, unknown>): Stamp | undefined => {
  const value: unknown = state[STAMP_KEY]
  if (value === null || typeof value !== 'object') return undefined
  const [stampRun, at]: unknown[] = [Reflect.get(value, 'run'), Reflect.get(value, 'position')]
  return typeof stampRun === 'string' && typeof at === 'number'
    ? { run: stampRun, position: at }
    : undefined
}

const samePage = (a: string, b: string): boolean => {
  const [x, y] = [new URL(a, window.location.href), new URL(b, window.location.href)]
  const query = (u: URL) => new URLSearchParams(u.search).toString()
  return (
    x.origin === y.origin && x.pathname === y.pathname && query(x) === query(y) && x.hash === y.hash
  )
}

/** Shows `url`, pushed or replaced (keeping the entry's other state); never rewrites the URL shown. */
export function writeEditorUrl(url: string, push: boolean): void {
  if (samePage(url, window.location.href)) return
  if (!run) newRun()
  const at = (position ?? 0) + (push ? 1 : 0)
  const kept = push ? {} : currentState()
  for (const key of ROUTER_KEYS) delete kept[key]
  const method = push ? window.history.pushState : window.history.replaceState
  method.call(window.history, { ...kept, [STAMP_KEY]: { run, position: at } }, '', url)
  position = at
}

/** Stamps the history entry the editor opened on, keeping Next.js's keys: the URL is unchanged. */
export function markEditorHistoryStart(): void {
  const state = currentState()
  const stamp = stampIn(state)
  if (stamp) {
    run = stamp.run
    position = stamp.position
    return
  }
  newRun()
  position = 0
  window.history.replaceState(
    { ...state, [STAMP_KEY]: { run, position } },
    '',
    window.location.href,
  )
}

/** On `popstate`: entries moved, undefined if an end is not this run's, null for an undo's. */
export function recordHistoryMove(): number | undefined | null {
  const arrived = stampIn(currentState())
  const undone =
    undoTarget !== undefined &&
    arrived?.run === undoTarget.run &&
    arrived.position === undoTarget.position
  undoTarget = undefined
  const moved =
    arrived?.run === run && position !== undefined ? arrived.position - position : undefined
  if (arrived) {
    run = arrived.run
    position = arrived.position
  } else newRun()
  return undone ? null : moved
}

export function undoHistoryMove(moved: number): void {
  if (position === undefined) return
  undoTarget = { run, position: position - moved }
  window.history.go(-moved)
}
