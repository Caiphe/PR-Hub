import type { Findings } from '@shared/findings'
import type { HistorySummary } from '@shared/history'
import { parsePrUrl } from '@shared/validate'
import { VERDICTS } from './verdict'

// Pure logic for the History view: search, filters, repositories and PR timelines. Kept out of
// components so every rule is unit-tested.

export interface HistoryFilters {
  query: string
  /** 'none': reviews without structured findings (failed, or the model skipped the block). */
  verdict: 'all' | Findings['verdict'] | 'none'
  status: 'all' | HistorySummary['status']
  posted: 'all' | 'posted' | 'unposted'
  pinned: 'all' | 'pinned'
  /** Lower-cased owner/repo; empty means every repository. */
  repo: string
  /** Inclusive local dates as YYYY-MM-DD (what <input type="date"> gives); empty means open. */
  from: string
  to: string
}

export const NO_HISTORY_FILTERS: HistoryFilters = {
  query: '',
  verdict: 'all',
  status: 'all',
  posted: 'all',
  pinned: 'all',
  repo: '',
  from: '',
  to: ''
}

export function isHistoryFiltering(filters: HistoryFilters): boolean {
  return countHistoryFilters(filters) > 0 || filters.query.trim() !== ''
}

/** Filters set in the filter panel (the search box isn't counted). */
export function countHistoryFilters(filters: HistoryFilters): number {
  return (
    (filters.verdict !== 'all' ? 1 : 0) +
    (filters.status !== 'all' ? 1 : 0) +
    (filters.posted !== 'all' ? 1 : 0) +
    (filters.pinned !== 'all' ? 1 : 0) +
    (filters.repo ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0)
  )
}

/** "owner/repo#12" and the lower-cased grouping keys, or null for a link that doesn't parse. */
function prParts(prUrl: string): { label: string; repo: string; key: string } | null {
  const ref = parsePrUrl(prUrl)
  if (!ref) return null
  const repo = `${ref.owner}/${ref.repo}`
  return {
    label: `${repo}#${ref.number}`,
    repo: repo.toLowerCase(),
    key: `${repo}#${ref.number}`.toLowerCase()
  }
}

/** Midnight at the start of a local YYYY-MM-DD date, or null when it isn't one. */
export function localDayStart(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

function matchesQuery(item: HistorySummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const pr = prParts(item.prUrl)
  const haystack = [item.title, pr?.label ?? item.prUrl, item.summary].join('\n').toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/**
 * Every filter must match (AND); order is kept. Search covers task title, owner/repo#number
 * and the review summary, word by word. Dates compare the review's start in local time.
 */
export function filterHistory(
  items: readonly HistorySummary[],
  filters: HistoryFilters
): HistorySummary[] {
  const from = localDayStart(filters.from)
  const toStart = localDayStart(filters.to)
  const until = toStart === null ? null : toStart + 24 * 60 * 60 * 1000
  return items.filter((item) => {
    if (filters.verdict === 'none' && item.verdict !== null) return false
    if (filters.verdict !== 'all' && filters.verdict !== 'none' && item.verdict !== filters.verdict)
      return false
    if (filters.status !== 'all' && item.status !== filters.status) return false
    if (filters.posted === 'posted' && item.postCount === 0) return false
    if (filters.posted === 'unposted' && item.postCount > 0) return false
    if (filters.pinned === 'pinned' && !item.pinned) return false
    if (filters.repo && prParts(item.prUrl)?.repo !== filters.repo) return false
    if (from !== null && item.startedAt < from) return false
    if (until !== null && item.startedAt >= until) return false
    return matchesQuery(item, filters.query)
  })
}

/** Repositories in history, for the filter menu: lower-cased value, display label. */
export function repositories(items: readonly HistorySummary[]): { value: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const item of items) {
    const ref = parsePrUrl(item.prUrl)
    if (!ref) continue
    const label = `${ref.owner}/${ref.repo}`
    if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label)
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, label]) => ({ value, label }))
}

export interface PrTimeline {
  key: string
  prUrl: string
  /** owner/repo#number, or the raw link when it doesn't parse. */
  label: string
  /** Newest first. */
  runs: HistorySummary[]
}

/**
 * Groups reviews of the same PR (owner and repo compared case-insensitively). Timelines are
 * ordered by their newest run, and runs newest first.
 */
export function groupByPr(items: readonly HistorySummary[]): PrTimeline[] {
  const groups = new Map<string, PrTimeline>()
  for (const item of items) {
    const pr = prParts(item.prUrl)
    const key = pr?.key ?? item.prUrl
    const group = groups.get(key)
    if (group) group.runs.push(item)
    else groups.set(key, { key, prUrl: item.prUrl, label: pr?.label ?? item.prUrl, runs: [item] })
  }
  const timelines = [...groups.values()]
  for (const t of timelines) t.runs.sort((a, b) => b.startedAt - a.startedAt)
  return timelines.sort((a, b) => b.runs[0].startedAt - a.runs[0].startedAt)
}

const VERDICT_FILTER_LABEL = (verdict: HistoryFilters['verdict']): string =>
  verdict === 'none' ? 'no structured verdict' : VERDICTS[verdict as Findings['verdict']].label

/** Plain-language list of active filters, for the "nothing matches" message. */
export function describeHistoryFilters(
  filters: HistoryFilters,
  repoLabel?: (value: string) => string
): string[] {
  const parts: string[] = []
  if (filters.verdict !== 'all') parts.push(VERDICT_FILTER_LABEL(filters.verdict))
  if (filters.status === 'done') parts.push('finished')
  if (filters.status === 'error') parts.push('failed')
  if (filters.posted === 'posted') parts.push('posted to GitHub')
  if (filters.posted === 'unposted') parts.push('not posted')
  if (filters.pinned === 'pinned') parts.push('pinned')
  if (filters.repo) parts.push(`in ${repoLabel?.(filters.repo) ?? filters.repo}`)
  if (filters.from && filters.to) parts.push(`from ${filters.from} to ${filters.to}`)
  else if (filters.from) parts.push(`on or after ${filters.from}`)
  else if (filters.to) parts.push(`on or before ${filters.to}`)
  if (filters.query.trim()) parts.push(`matching “${filters.query.trim()}”`)
  return parts
}

/** "Not posted", "Posted", or "Posted 2×" when several reviews went to GitHub. */
export function postingLabel(item: HistorySummary): string {
  if (item.postCount === 0) return 'Not posted'
  return item.postCount === 1 ? 'Posted' : `Posted ${item.postCount}×`
}

export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null
}
