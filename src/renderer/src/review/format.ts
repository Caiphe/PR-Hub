import { parsePrUrl } from '@shared/validate'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}

export function formatCost(usd: number | null): string | null {
  if (usd === null) return null
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function prLabel(url: string): string {
  const ref = parsePrUrl(url)
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}` : url
}

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function formatRelative(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
