/**
 * The server's clock as the editor last heard it, so a wait timed against a server timestamp
 * (base-update-wait.ts) doesn't depend on the browser's clock being right. One offset per page:
 * the editor talks to one server.
 */
let offsetMs = 0

/** Record a time the server reported, as of when its answer arrived. */
export function noteServerTime(serverTime: number, receivedAt = Date.now()): void {
  if (Number.isFinite(serverTime)) offsetMs = serverTime - receivedAt
}

/** Now, by the server's clock as last heard; the browser's until then. */
export function serverNow(): number {
  return Date.now() + offsetMs
}
