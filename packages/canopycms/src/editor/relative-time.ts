const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Formats an ISO timestamp as a short relative-time label ("just now", "5m ago", "3h ago",
 * "2d ago", "2w ago", "3mo ago", "1y ago"). Weeks run to 4, months to 11. A timestamp in the
 * future reads "just now", and invalid input is returned unchanged so callers never render
 * "Invalid Date" to the user.
 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }

  const diffMs = Date.now() - date.getTime()
  const minutes = Math.floor(diffMs / MINUTE_MS)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(diffMs / HOUR_MS)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(diffMs / DAY_MS)
  if (days < 7) return `${days}d ago`
  if (days < 35) return `${Math.floor(days / 7)}w ago`

  const years = Math.floor(days / 365)
  if (years >= 1) return `${years}y ago`
  return `${Math.min(11, Math.max(1, Math.floor(days / 30)))}mo ago`
}
