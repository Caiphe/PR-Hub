import { describe, expect, it } from 'vitest'
import type { HistorySummary } from '@shared/history'
import {
  countHistoryFilters,
  describeHistoryFilters,
  filterHistory,
  groupByPr,
  isHistoryFiltering,
  localDayStart,
  NO_HISTORY_FILTERS,
  postingLabel,
  repositories,
  type HistoryFilters
} from './historyView'

const day = (date: string, hour = 12): number => localDayStart(date)! + hour * 60 * 60 * 1000

const s = (id: string, extra: Partial<HistorySummary> = {}): HistorySummary => ({
  id,
  title: `Task ${id}`,
  prUrl: 'https://github.com/acme/hooks/pull/12',
  startedAt: day('2026-10-01'),
  endedAt: day('2026-10-01'),
  durationMs: 60000,
  status: 'done',
  verdict: 'approve',
  summary: '',
  costUsd: 0.1,
  headSha: null,
  counts: { blocking: 0, should_fix: 0, nit: 0 },
  postCount: 0,
  postedFindings: 0,
  pinned: false,
  ...extra
})

const items: HistorySummary[] = [
  s('r5', {
    title: 'Add webhook retries',
    startedAt: day('2026-10-20'),
    verdict: 'request_changes',
    summary: 'Retries never back off',
    postCount: 1
  }),
  s('r4', {
    title: 'Docs typo',
    prUrl: 'https://github.com/acme/docs/pull/3',
    startedAt: day('2026-10-15'),
    pinned: true
  }),
  s('r3', {
    title: 'Add webhook retries',
    startedAt: day('2026-10-10'),
    verdict: 'approve_with_suggestions'
  }),
  s('r2', {
    title: 'Fork fix',
    prUrl: 'https://github.com/Other/Hooks/pull/12',
    startedAt: day('2026-10-05'),
    status: 'error',
    verdict: null,
    counts: null
  }),
  s('r1', {
    title: 'Upper-case owner',
    prUrl: 'https://github.com/ACME/Hooks/pull/12',
    startedAt: day('2026-10-01'),
    verdict: null
  })
]

const ids = (filters: Partial<HistoryFilters>): string[] =>
  filterHistory(items, { ...NO_HISTORY_FILTERS, ...filters }).map((i) => i.id)

describe('filterHistory search', () => {
  it('matches title, owner/repo, PR number and summary, word by word', () => {
    expect(ids({ query: 'webhook' })).toEqual(['r5', 'r3'])
    expect(ids({ query: 'acme/docs' })).toEqual(['r4'])
    expect(ids({ query: '#3' })).toEqual(['r4'])
    expect(ids({ query: 'acme/hooks#12' })).toEqual(['r5', 'r3', 'r1'])
    expect(ids({ query: 'back off' })).toEqual(['r5'])
    expect(ids({ query: 'RETRIES  never' })).toEqual(['r5'])
    expect(ids({ query: 'webhook docs' })).toEqual([])
    expect(ids({ query: '   ' })).toEqual(['r5', 'r4', 'r3', 'r2', 'r1'])
  })
})

describe('filterHistory filters', () => {
  it('filters by verdict, including reviews without one', () => {
    expect(ids({ verdict: 'approve' })).toEqual(['r4'])
    expect(ids({ verdict: 'request_changes' })).toEqual(['r5'])
    expect(ids({ verdict: 'none' })).toEqual(['r2', 'r1'])
  })

  it('filters by status, posting and pin', () => {
    expect(ids({ status: 'error' })).toEqual(['r2'])
    expect(ids({ status: 'done' })).toEqual(['r5', 'r4', 'r3', 'r1'])
    expect(ids({ posted: 'posted' })).toEqual(['r5'])
    expect(ids({ posted: 'unposted' })).toEqual(['r4', 'r3', 'r2', 'r1'])
    expect(ids({ pinned: 'pinned' })).toEqual(['r4'])
  })

  it('filters by repository case-insensitively', () => {
    expect(ids({ repo: 'acme/hooks' })).toEqual(['r5', 'r3', 'r1'])
    expect(ids({ repo: 'other/hooks' })).toEqual(['r2'])
  })

  it('filters by an inclusive local date range', () => {
    expect(ids({ from: '2026-10-10' })).toEqual(['r5', 'r4', 'r3'])
    expect(ids({ to: '2026-10-10' })).toEqual(['r3', 'r2', 'r1'])
    expect(ids({ from: '2026-10-05', to: '2026-10-15' })).toEqual(['r4', 'r3', 'r2'])
    // The whole end day counts, up to 23:59.
    const late = [s('late', { startedAt: day('2026-10-10', 23.99) })]
    expect(filterHistory(late, { ...NO_HISTORY_FILTERS, to: '2026-10-10' })).toHaveLength(1)
    expect(filterHistory(late, { ...NO_HISTORY_FILTERS, to: '2026-10-09' })).toHaveLength(0)
    // A malformed date is ignored rather than hiding everything.
    expect(ids({ from: 'yesterday' })).toHaveLength(5)
  })

  it('combines filters with AND', () => {
    expect(ids({ repo: 'acme/hooks', query: 'webhook', posted: 'unposted' })).toEqual(['r3'])
    expect(ids({ repo: 'acme/hooks', verdict: 'none', from: '2026-10-02' })).toEqual([])
  })

  it('counts and describes active filters', () => {
    expect(isHistoryFiltering(NO_HISTORY_FILTERS)).toBe(false)
    expect(isHistoryFiltering({ ...NO_HISTORY_FILTERS, query: 'x' })).toBe(true)
    const all: HistoryFilters = {
      query: ' retries ',
      verdict: 'none',
      status: 'error',
      posted: 'posted',
      pinned: 'pinned',
      repo: 'acme/hooks',
      from: '2026-10-01',
      to: '2026-10-31'
    }
    expect(countHistoryFilters(all)).toBe(6)
    expect(describeHistoryFilters(all, () => 'acme/Hooks')).toEqual([
      'no structured verdict',
      'failed',
      'posted to GitHub',
      'pinned',
      'in acme/Hooks',
      'from 2026-10-01 to 2026-10-31',
      'matching “retries”'
    ])
    expect(describeHistoryFilters({ ...NO_HISTORY_FILTERS, to: '2026-10-31' })).toEqual([
      'on or before 2026-10-31'
    ])
  })
})

describe('groupByPr', () => {
  it('groups repeat reviews of one PR, newest first', () => {
    const timelines = groupByPr(items)
    expect(timelines.map((t) => [t.label, t.runs.map((r) => r.id)])).toEqual([
      ['acme/hooks#12', ['r5', 'r3', 'r1']],
      ['acme/docs#3', ['r4']],
      ['Other/Hooks#12', ['r2']]
    ])
  })

  it('orders runs by date even when the input is not', () => {
    const shuffled = [items[4], items[0], items[2]]
    expect(groupByPr(shuffled)[0].runs.map((r) => r.id)).toEqual(['r5', 'r3', 'r1'])
  })

  it('keeps an unparsable link as its own timeline', () => {
    const odd = s('odd', { prUrl: 'not a url' })
    expect(groupByPr([odd])).toEqual([
      { key: 'not a url', prUrl: 'not a url', label: 'not a url', runs: [odd] }
    ])
  })
})

describe('repositories and labels', () => {
  it('lists each repository once, sorted', () => {
    expect(repositories(items)).toEqual([
      { value: 'acme/docs', label: 'acme/docs' },
      { value: 'acme/hooks', label: 'acme/hooks' },
      { value: 'other/hooks', label: 'Other/Hooks' }
    ])
  })

  it('labels posting status', () => {
    expect(postingLabel(s('a'))).toBe('Not posted')
    expect(postingLabel(s('a', { postCount: 1 }))).toBe('Posted')
    expect(postingLabel(s('a', { postCount: 3 }))).toBe('Posted 3×')
  })
})
