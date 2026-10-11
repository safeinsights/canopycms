const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** "512 B", "2.3 MB", "14 KB": 1024 base, one decimal below 10, whole numbers above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // 1023.6 KB rounds to "1024 KB"; promote it to 1.0 MB instead.
  if (unit > 0 && unit < UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024
    unit += 1
  }

  if (unit === 0) return `${Math.round(value)} B`
  const oneDecimal = Math.round(value * 10) / 10
  if (oneDecimal < 10) return `${oneDecimal.toFixed(1)} ${UNITS[unit]}`
  return `${Math.round(value)} ${UNITS[unit]}`
}
