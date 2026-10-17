/**
 * The editor's writes to session history, each stamped with its position, so a Back or Forward
 * it refuses can be undone. Module state, as a window has one session history.
 */
const POSITION_KEY = 'canopyHistoryPosition'

let position: number | undefined
// Where `undoHistoryMove` lands, so the popstate arriving there is known as its own.
let undoTarget: number | undefined

const stampedPosition = (): number | undefined => {
  const state: unknown = window.history.state
  const value =
    state !== null && typeof state === 'object' ? Reflect.get(state, POSITION_KEY) : undefined
  return typeof value === 'number' ? value : undefined
}

/**
 * Writes only the stamp: Next.js's patched history methods add its router keys and record the
 * new URL, which they skip for state already carrying those keys.
 */
const write = (push: boolean, at: number, url: string) => {
  const method = push ? window.history.pushState : window.history.replaceState
  method.call(window.history, { [POSITION_KEY]: at }, '', url)
  position = at
}

/** Whether two URLs name the same page, however each encodes its query. */
const samePage = (a: string, b: string): boolean => {
  const [x, y] = [new URL(a, window.location.href), new URL(b, window.location.href)]
  const query = (u: URL) => new URLSearchParams(u.search).toString()
  return (
    x.origin === y.origin && x.pathname === y.pathname && query(x) === query(y) && x.hash === y.hash
  )
}

/** The current entry's position; a stamp a host write dropped falls back to the last known. */
const here = (): number => stampedPosition() ?? position ?? 0

/** Shows `url`, pushed or replaced; never rewrites the URL already shown. */
export function writeEditorUrl(url: string, push: boolean): void {
  if (samePage(url, window.location.href)) return
  write(push, here() + (push ? 1 : 0), url)
}

/** Stamps the history entry the editor opened on, which it did not write. */
export function markEditorHistoryStart(): void {
  if (stampedPosition() === undefined) write(false, here(), window.location.href)
  else position = stampedPosition()
}

/** On `popstate`: entries moved, undefined if an end is not the editor's, null for an undo's. */
export function recordHistoryMove(): number | undefined | null {
  const arrived = stampedPosition()
  const moved = arrived === undefined || position === undefined ? undefined : arrived - position
  const undone = undoTarget !== undefined && arrived === undoTarget
  undoTarget = undefined
  position = arrived
  return undone ? null : moved
}

/** Steps back over a move of `moved` entries, to the entry it left. */
export function undoHistoryMove(moved: number): void {
  if (position === undefined) return
  undoTarget = position - moved
  window.history.go(-moved)
}
