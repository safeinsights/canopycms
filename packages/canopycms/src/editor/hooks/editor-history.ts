/**
 * The editor's writes to session history, each stamped with its position, so a Back or Forward
 * it refuses can be undone. Module state, as a window has one session history.
 */
const POSITION_KEY = 'canopyHistoryPosition'

let position: number | undefined
let ownMoves = 0

const currentState = (): Record<string, unknown> => {
  const state: unknown = window.history.state
  return state !== null && typeof state === 'object' ? { ...state } : {}
}

const positionIn = (state: Record<string, unknown>): number | undefined => {
  const value = state[POSITION_KEY]
  return typeof value === 'number' ? value : undefined
}

/** Whether two URLs name the same page, however each encodes its query. */
const samePage = (a: string, b: string): boolean => {
  const [x, y] = [new URL(a, window.location.href), new URL(b, window.location.href)]
  const query = (u: URL) => new URLSearchParams(u.search).toString()
  return (
    x.origin === y.origin && x.pathname === y.pathname && query(x) === query(y) && x.hash === y.hash
  )
}

/** Shows `url`, pushed or replaced, keeping Next.js's router state; never rewrites the URL shown. */
export function writeEditorUrl(url: string, push: boolean): void {
  if (samePage(url, window.location.href)) return
  const state = currentState()
  const next = (positionIn(state) ?? 0) + (push ? 1 : 0)
  const write = push ? window.history.pushState : window.history.replaceState
  write.call(window.history, { ...state, [POSITION_KEY]: next }, '', url)
  position = next
}

/** Stamps the history entry the editor opened on, which it did not write. */
export function markEditorHistoryStart(): void {
  const state = currentState()
  if (positionIn(state) === undefined) {
    window.history.replaceState({ ...state, [POSITION_KEY]: 0 }, '', window.location.href)
  }
  position = positionIn(currentState())
}

/** On `popstate`: entries moved, undefined if an end is not the editor's, null for an undo's. */
export function recordHistoryMove(): number | undefined | null {
  const arrived = positionIn(currentState())
  const moved = arrived === undefined || position === undefined ? undefined : arrived - position
  position = arrived
  if (ownMoves > 0) {
    ownMoves -= 1
    return null
  }
  return moved
}

/** Steps back over a move of `moved` entries, to the entry it left. */
export function undoHistoryMove(moved: number): void {
  ownMoves += 1
  window.history.go(-moved)
}
