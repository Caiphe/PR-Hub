import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { HistorySummary } from '@shared/history'
import type { HistoryExportFormat } from '@shared/ipc'
import { formatCost, formatDuration } from '../review/format'
import {
  countHistoryFilters,
  describeHistoryFilters,
  filterHistory,
  groupByPr,
  isHistoryFiltering,
  NO_HISTORY_FILTERS,
  postingLabel,
  repositories,
  shortSha,
  type HistoryFilters,
  type PrTimeline
} from '../review/historyView'
import { dialogOpen } from '../review/keyboard'
import { sessionPrefs } from '../review/sessionPrefs'
import { VERDICTS } from '../review/verdict'
import { PinButton } from './PinButton'

// Timelines rendered at first; more on request, so a long history stays quick to draw.
const PAGE = 25

function PinIcon({ filled }: { filled: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M8 2.2l1.75 3.55 3.9.57-2.83 2.76.67 3.89L8 11.13l-3.49 1.84.67-3.89L2.35 6.32l3.9-.57z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Verdict({ item }: { item: HistorySummary }): React.JSX.Element {
  if (item.status === 'error') return <span className="pill pill-bad">Failed</span>
  if (!item.verdict) return <span className="pill pill-muted">Done</span>
  const verdict = VERDICTS[item.verdict]
  return <span className={`pill pill-${verdict.tone}`}>{verdict.label}</span>
}

function Counts({ counts }: { counts: NonNullable<HistorySummary['counts']> }): React.JSX.Element {
  const label = `${counts.blocking} blocking, ${counts.should_fix} should fix, ${counts.nit} nits`
  return (
    <span className="run-counts" aria-label={label} title={label}>
      <span>
        <span className="dot dot-bad" aria-hidden="true" />
        {counts.blocking}
      </span>
      <span>
        <span className="dot dot-warn" aria-hidden="true" />
        {counts.should_fix}
      </span>
      <span>
        <span className="dot dot-muted" aria-hidden="true" />
        {counts.nit}
      </span>
    </span>
  )
}

function Lineage({
  item,
  parentShown,
  onOpenParent
}: {
  item: HistorySummary
  parentShown: boolean
  onOpenParent: () => void
}): React.JSX.Element | null {
  if (item.fallbackReason) {
    return (
      <span className="run-lineage" title={item.fallbackReason}>
        Asked for changes only; ran as a full review
      </span>
    )
  }
  const inc = item.incremental
  if (!inc) return null
  const c = inc.counts
  return (
    <span className="run-lineage">
      Changes since{' '}
      {parentShown ? (
        <button type="button" className="link-button" onClick={onOpenParent}>
          <code>{shortSha(inc.comparedSha)}</code>
        </button>
      ) : (
        <code>{shortSha(inc.comparedSha)}</code>
      )}
      {c &&
        ` · ${c.new} new · ${c.still_present} still present · ${c.resolved} resolved` +
          (c.unable_to_verify ? ` · ${c.unable_to_verify} to check` : '')}
    </span>
  )
}

function Run({
  item,
  showTitle,
  open,
  onOpen,
  onToggleActions,
  onPin,
  onExport,
  onDelete,
  actionsId,
  parentShown,
  onOpenParent
}: {
  item: HistorySummary
  showTitle: boolean
  /** The review this one compared against is in the list, so it can be opened. */
  parentShown: boolean
  onOpenParent: () => void
  open: boolean
  onOpen: () => void
  onToggleActions: () => void
  onPin: () => void
  onExport: (format: HistoryExportFormat) => void
  onDelete: () => void
  actionsId: string
}): React.JSX.Element {
  const date = new Date(item.startedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const sha = shortSha(item.headSha)
  const cost = formatCost(item.costUsd)
  const posting = postingLabel(item)

  return (
    <li className={`run ${open ? 'is-open' : ''}`}>
      <div className="run-row">
        <button type="button" className="run-open" onClick={onOpen}>
          {showTitle && <span className="run-title">{item.title}</span>}
          <span className="run-meta">
            {date}
            {sha && (
              <>
                {' · '}
                <code title={item.headSha ?? undefined}>{sha}</code>
              </>
            )}
            {' · '}
            {formatDuration(item.durationMs)}
            {cost && ` · ${cost}`}
          </span>
          <span className="run-badges">
            <Verdict item={item} />
            {item.counts && <Counts counts={item.counts} />}
            <span className={item.postCount > 0 ? 'run-posted is-posted' : 'run-posted'}>
              {posting}
            </span>
          </span>
        </button>
        <button
          type="button"
          className={`icon-button run-pin ${item.pinned ? 'is-pinned' : ''}`}
          aria-pressed={item.pinned}
          aria-label={`Pin review from ${date}`}
          title={item.pinned ? 'Pinned: kept past the history limit' : 'Pin to keep it'}
          onClick={onPin}
        >
          <PinIcon filled={item.pinned} />
        </button>
        <button
          type="button"
          className="icon-button run-more"
          aria-expanded={open}
          aria-controls={actionsId}
          aria-label={`More actions for the review from ${date}`}
          title="Export or delete"
          onClick={onToggleActions}
        >
          ⋯
        </button>
      </div>
      <Lineage item={item} parentShown={parentShown} onOpenParent={onOpenParent} />
      {open && (
        <div className="run-actions" id={actionsId}>
          <button
            type="button"
            className="secondary small-button"
            onClick={() => onExport('markdown')}
          >
            Export Markdown
          </button>
          <button type="button" className="secondary small-button" onClick={() => onExport('json')}>
            Export JSON
          </button>
          <button type="button" className="secondary small-button danger-button" onClick={onDelete}>
            Delete…
          </button>
        </div>
      )}
    </li>
  )
}

function Timeline({
  timeline,
  actionsFor,
  ids,
  ...handlers
}: {
  timeline: PrTimeline
  actionsFor: string | null
  /** Ids of every review in history, to know whether a parent review can be opened. */
  ids: ReadonlySet<string>
  onOpen: (id: string) => void
  onToggleActions: (id: string) => void
  onPin: (item: HistorySummary) => void
  onExport: (id: string, format: HistoryExportFormat) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const prefix = useId()
  const runs = timeline.runs
  return (
    <section className="timeline" aria-label={`${timeline.label}, ${runs.length} reviews`}>
      <h2 className="timeline-head">
        <a href={timeline.prUrl} target="_blank" rel="noreferrer" className="pr-ref">
          {timeline.label}
        </a>
        <span className="count">
          {runs.length} {runs.length === 1 ? 'review' : 'reviews'}
        </span>
      </h2>
      <ol className="run-list">
        {runs.map((item, i) => (
          <Run
            key={item.id}
            item={item}
            // Repeat runs usually share a task; only show the title when it changes.
            showTitle={i === 0 || runs[i - 1].title !== item.title}
            open={actionsFor === item.id}
            actionsId={`${prefix}-actions-${item.id}`}
            onOpen={() => handlers.onOpen(item.id)}
            onToggleActions={() => handlers.onToggleActions(item.id)}
            onPin={() => handlers.onPin(item)}
            onExport={(format) => handlers.onExport(item.id, format)}
            onDelete={() => handlers.onDelete(item.id)}
            parentShown={!!item.incremental && ids.has(item.incremental.parentId)}
            onOpenParent={() => item.incremental && handlers.onOpen(item.incremental.parentId)}
          />
        ))}
      </ol>
    </section>
  )
}

export function HistoryView({
  onBack,
  onOpen
}: {
  onBack: () => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  const prefix = useId()
  const [items, setItems] = useState<HistorySummary[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [filters, setFiltersState] = useState<HistoryFilters>(() => sessionPrefs.historyFilters)
  const [showFilters, setShowFilters] = useState(() => countHistoryFilters(filters) > 0)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [message, setMessage] = useState('')

  const setFilters = (next: HistoryFilters): void => {
    sessionPrefs.historyFilters = next
    setFiltersState(next)
    setShown(PAGE)
  }

  useEffect(() => {
    let alive = true
    window.api
      .listHistory()
      .then((list) => alive && setItems(list))
      .catch(() => {
        if (!alive) return
        setLoadError(true)
        setItems([])
      })
    return () => {
      alive = false
    }
  }, [])

  const all = useMemo(() => items ?? [], [items])
  const repos = useMemo(() => repositories(all), [all])
  const ids = useMemo(() => new Set(all.map((i) => i.id)), [all])
  const visible = useMemo(() => filterHistory(all, filters), [all, filters])
  const timelines = useMemo(() => groupByPr(visible), [visible])
  const filtering = isHistoryFiltering(filters)
  const panelFilters = countHistoryFilters(filters)
  const repoLabel = (value: string): string => repos.find((r) => r.value === value)?.label ?? value

  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const backRef = useRef(onBack)
  useEffect(() => {
    backRef.current = onBack
  })
  // Esc goes back, unless a dialog is open or the search box used it to clear itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !dialogOpen()) backRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const replace = (next: HistorySummary): void =>
    setItems((list) => list?.map((i) => (i.id === next.id ? next : i)) ?? null)

  const pin = async (item: HistorySummary): Promise<void> => {
    const next = await window.api.setHistoryPinned(item.id, !item.pinned).catch(() => null)
    if (next) {
      replace(next)
      setMessage(next.pinned ? 'Pinned. It stays past the history limit.' : 'Unpinned.')
    } else {
      setMessage("Couldn't change the pin. The review may have been removed.")
    }
  }

  const exportReview = async (id: string, format: HistoryExportFormat): Promise<void> => {
    const res = await window.api
      .exportHistory(id, format)
      .catch((error) => ({ status: 'failed' as const, error: (error as Error).message }))
    if (res.status === 'saved') setMessage(`Saved ${res.fileName}.`)
    else if (res.status === 'failed') setMessage(`Export failed: ${res.error}`)
  }

  const remove = async (id: string): Promise<void> => {
    const res = await window.api.deleteHistory(id).catch(() => null)
    if (res === 'deleted' || res === 'missing') {
      setItems((list) => list?.filter((i) => i.id !== id) ?? null)
      setActionsFor(null)
      setMessage('Review deleted from this Mac.')
    } else if (res === 'cancelled') {
      // Dismissing the dialog closes the actions too, so nothing is left half-open.
      setActionsFor(null)
    } else {
      setMessage("Couldn't delete the review.")
    }
  }

  const filtersId = `${prefix}-filters`
  const select = <K extends keyof HistoryFilters>(
    key: K,
    label: string,
    options: [HistoryFilters[K], string][]
  ): React.JSX.Element => (
    <label className="filter-select">
      {label}
      <select
        value={filters[key] as string}
        onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
      >
        {options.map(([value, text]) => (
          <option key={value as string} value={value as string}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div className="review-view history-view">
      <header className="review-header">
        <button
          type="button"
          className="icon-button"
          onClick={onBack}
          aria-label="Back to the form"
          title="Back (Esc)"
        >
          ←
        </button>
        <div className="review-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            History
          </h1>
          <span className="muted small">Saved on this Mac</span>
        </div>
        <PinButton />
      </header>

      <div className="review-body">
        {items === null ? (
          <p className="muted">Loading…</p>
        ) : all.length === 0 ? (
          <section className="empty-state">
            <h2>No saved reviews yet</h2>
            <p className="muted">
              {loadError
                ? "History couldn't be loaded."
                : 'Finished reviews are saved here, grouped by pull request.'}
            </p>
          </section>
        ) : (
          <section className="findings-workspace" aria-label="Saved reviews">
            <div className="findings-toolbar">
              <input
                type="search"
                className="findings-search"
                value={filters.query}
                placeholder="Search history"
                aria-label="Search by task title, owner/repository, PR number or review summary"
                onChange={(e) => setFilters({ ...filters, query: e.target.value })}
                onKeyDown={(e) => {
                  // Esc clears the search first; the next Esc goes back as usual.
                  if (e.key === 'Escape' && filters.query) {
                    e.preventDefault()
                    setFilters({ ...filters, query: '' })
                  }
                }}
              />
              <button
                type="button"
                className={`secondary small-button ${showFilters ? 'is-on' : ''}`}
                aria-expanded={showFilters}
                aria-controls={filtersId}
                onClick={() => setShowFilters((s) => !s)}
              >
                Filters
                {panelFilters > 0 ? ` · ${panelFilters}` : ''}
              </button>
            </div>

            {showFilters && (
              <div className="findings-filters history-filters" id={filtersId}>
                {select('verdict', 'Verdict', [
                  ['all', 'All'],
                  ['approve', VERDICTS.approve.label],
                  ['approve_with_suggestions', 'With suggestions'],
                  ['request_changes', VERDICTS.request_changes.label],
                  ['none', 'No verdict']
                ])}
                {select('status', 'Status', [
                  ['all', 'All'],
                  ['done', 'Finished'],
                  ['error', 'Failed']
                ])}
                {select('posted', 'Posting', [
                  ['all', 'All'],
                  ['posted', 'Posted'],
                  ['unposted', 'Not posted']
                ])}
                {select('pinned', 'Pinned', [
                  ['all', 'All'],
                  ['pinned', 'Pinned only']
                ])}
                {select('repo', 'Repository', [
                  ['', 'All'],
                  ...repos.map((r): [string, string] => [r.value, r.label])
                ])}
                <label className="filter-select">
                  From
                  <input
                    type="date"
                    value={filters.from}
                    max={filters.to || undefined}
                    onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                  />
                </label>
                <label className="filter-select">
                  To
                  <input
                    type="date"
                    value={filters.to}
                    min={filters.from || undefined}
                    onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                  />
                </label>
                {filtering && (
                  <button
                    type="button"
                    className="link-button small"
                    onClick={() => setFilters(NO_HISTORY_FILTERS)}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}

            <div className="findings-nav">
              <span className="findings-count" role="status" aria-live="polite">
                {filtering
                  ? `Showing ${visible.length} of ${all.length} reviews`
                  : `${all.length} ${all.length === 1 ? 'review' : 'reviews'}`}
                {` · ${timelines.length} ${timelines.length === 1 ? 'PR' : 'PRs'}`}
              </span>
            </div>
            <p className="history-message muted small" role="status" aria-live="polite">
              {message}
            </p>

            {visible.length === 0 ? (
              <div className="filter-empty">
                <p>No reviews match: {describeHistoryFilters(filters, repoLabel).join(' · ')}.</p>
                <button
                  type="button"
                  className="secondary small-button"
                  onClick={() => setFilters(NO_HISTORY_FILTERS)}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <>
                {timelines.slice(0, shown).map((t) => (
                  <Timeline
                    key={t.key}
                    timeline={t}
                    actionsFor={actionsFor}
                    ids={ids}
                    onOpen={onOpen}
                    onToggleActions={(id) => setActionsFor((cur) => (cur === id ? null : id))}
                    onPin={(item) => void pin(item)}
                    onExport={(id, format) => void exportReview(id, format)}
                    onDelete={(id) => void remove(id)}
                  />
                ))}
                {timelines.length > shown && (
                  <button
                    type="button"
                    className="secondary small-button"
                    onClick={() => setShown((n) => n + PAGE)}
                  >
                    Show more ({timelines.length - shown} PRs)
                  </button>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
