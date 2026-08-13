/**
 * Formats an ISO timestamp as a short relative-time label ("just now",
 * "5m ago", "3h ago", "2d ago"), falling back to a locale date string once
 * the timestamp is more than a week old. Invalid input is returned
 * unchanged so callers never render "Invalid Date" to the user.
 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }

  const diffMs = Date.now() - date.getTime()
  const minutes = Math.floor(diffMs / (1000 * 60))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days < 7) return `${days}d ago`

  return date.toLocaleDateString()
}
