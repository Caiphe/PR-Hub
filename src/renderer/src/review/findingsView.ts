import type { Finding } from '@shared/findings'
import { SEVERITIES } from '@shared/findings'
import { parsePrUrl } from '@shared/validate'

// Pure logic for the findings workspace: filtering, grouping, counts, navigation order and
// GitHub links. Kept out of components so every rule is unit-tested.

export type Severity = Finding['severity']
export type GroupMode = 'severity' | 'file'

export interface Filters {
  /** Severities to show; empty means all. */
  severities: Severity[]
  selection: 'all' | 'selected' | 'unselected'
  posted: 'all' | 'posted' | 'unposted'
  query: string
}

export const NO_FILTERS: Filters = { severities: [], selection: 'all', posted: 'all', query: '' }

export const SEVERITY_INFO: Record<Severity, { title: string; tone: string; rank: number }> = {
  blocking: { title: 'Blocking', tone: 'bad', rank: 0 },
  should_fix: { title: 'Should fix', tone: 'warn', rank: 1 },
  nit: { title: 'Nits', tone: 'muted', rank: 2 }
}

export interface FilterContext {
  selected: ReadonlySet<string>
  posted: ReadonlySet<string>
}

export function isFiltering(filters: Filters): boolean {
  return (
    filters.severities.length > 0 ||
    filters.selection !== 'all' ||
    filters.posted !== 'all' ||
    filters.query.trim() !== ''
  )
}

function matchesQuery(f: Finding, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [f.title, f.body, f.file ?? '', f.suggestion ?? ''].join('\n').toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/** Every filter must match (AND); order is kept. Selection itself is never changed. */
export function filterFindings(
  findings: readonly Finding[],
  filters: Filters,
  ctx: FilterContext
): Finding[] {
  return findings.filter((f) => {
    if (filters.severities.length > 0 && !filters.severities.includes(f.severity)) return false
    if (filters.selection === 'selected' && !ctx.selected.has(f.id)) return false
    if (filters.selection === 'unselected' && ctx.selected.has(f.id)) return false
    if (filters.posted === 'posted' && !ctx.posted.has(f.id)) return false
    if (filters.posted === 'unposted' && ctx.posted.has(f.id)) return false
    return matchesQuery(f, filters.query)
  })
}

export interface FindingGroup {
  key: string
  title: string
  /** Severity groups only. */
  tone?: string
  /** File groups only; null for findings not tied to a file. */
  file?: string | null
  items: Finding[]
}

const bySeverityThenLine = (a: Finding, b: Finding): number =>
  SEVERITY_INFO[a.severity].rank - SEVERITY_INFO[b.severity].rank ||
  (a.line ?? Infinity) - (b.line ?? Infinity)

/**
 * Severity mode: Blocking, Should fix, Nits (model order within each). File mode: files
 * alphabetically, then findings without a file; within a file by severity, then line.
 * Empty groups are dropped.
 */
export function groupFindings(findings: readonly Finding[], mode: GroupMode): FindingGroup[] {
  if (mode === 'severity') {
    return SEVERITIES.map((severity) => ({
      key: severity,
      title: SEVERITY_INFO[severity].title,
      tone: SEVERITY_INFO[severity].tone,
      items: findings.filter((f) => f.severity === severity)
    })).filter((g) => g.items.length > 0)
  }
  const files = new Map<string, Finding[]>()
  const general: Finding[] = []
  for (const f of findings) {
    if (!f.file) general.push(f)
    else files.set(f.file, [...(files.get(f.file) ?? []), f])
  }
  const groups: FindingGroup[] = [...files.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({
      key: `file:${file}`,
      title: file,
      file,
      items: [...files.get(file)!].sort(bySeverityThenLine)
    }))
  if (general.length > 0) {
    groups.push({
      key: 'file:',
      title: 'Not tied to a file',
      file: null,
      items: [...general].sort(bySeverityThenLine)
    })
  }
  return groups
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocking: 0, should_fix: 0, nit: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

/** Finding ids in the order they're displayed. */
export function navigationOrder(groups: readonly FindingGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((f) => f.id))
}

/**
 * The finding to move to. With nothing current (or the current one filtered out), Next goes
 * to the first and Previous to the last. Stops at the ends rather than wrapping.
 */
export function stepFinding(
  order: readonly string[],
  current: string | null,
  direction: 1 | -1
): string | null {
  if (order.length === 0) return null
  const at = current ? order.indexOf(current) : -1
  if (at === -1) return direction === 1 ? order[0] : order[order.length - 1]
  return order[Math.min(order.length - 1, Math.max(0, at + direction))]
}

/** Plain-language list of the active filters, for the "nothing matches" message. */
export function describeFilters(filters: Filters): string[] {
  const parts: string[] = []
  if (filters.severities.length > 0) {
    parts.push(filters.severities.map((s) => SEVERITY_INFO[s].title).join(' or '))
  }
  if (filters.selection === 'selected') parts.push('selected for posting')
  if (filters.selection === 'unselected') parts.push('not selected')
  if (filters.posted === 'posted') parts.push('already posted')
  if (filters.posted === 'unposted') parts.push('not posted yet')
  if (filters.query.trim()) parts.push(`matching “${filters.query.trim()}”`)
  return parts
}

/**
 * A link to the finding's line in the reviewed commit, or null when it can't be built safely.
 * Every part is validated: the PR link must parse, the commit must be a full SHA, the line a
 * positive integer, and the model-supplied path a relative path with no "." or ".." segments.
 * Each path segment is percent-encoded, so spaces and Unicode work and nothing can add a query
 * or anchor of its own.
 */
export function githubFileUrl(
  prUrl: string,
  commit: string | null | undefined,
  file: string | null | undefined,
  line: number | null | undefined
): string | null {
  const ref = parsePrUrl(prUrl)
  if (!ref || !commit || !/^[0-9a-f]{40}$/.test(commit)) return null
  if (!file || !line || !Number.isSafeInteger(line) || line < 1) return null
  // Control characters and backslashes never appear in real repository paths.
  if ([...file].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\\' || ch === '\u007f')) return null
  const segments = file.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  const path = segments.map(encodeURIComponent).join('/')
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${commit}/${path}#L${line}`
}
