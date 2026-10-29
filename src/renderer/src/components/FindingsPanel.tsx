import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Finding, Findings, Requirement } from '@shared/findings'
import { SEVERITIES } from '@shared/findings'
import { codeFence, languageForFile, looksLikeProse } from '@shared/markdown'
import {
  countBySeverity,
  describeFilters,
  filterFindings,
  groupFindings,
  isFiltering,
  navigationOrder,
  NO_FILTERS,
  SEVERITY_INFO,
  stepFinding,
  type Filters,
  type GroupMode
} from '../review/findingsView'
import { dialogOpen } from '../review/keyboard'
import { VERDICTS } from '../review/verdict'
import { InlineMarkdown, Markdown } from './Markdown'

const REQUIREMENT_STATUS: Record<Requirement['status'], { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'good' },
  partial: { label: 'Partial', tone: 'warn' },
  missing: { label: 'Missing', tone: 'bad' }
}

/** Present when findings can be picked for posting to GitHub. */
export interface FindingSelection {
  selected: Set<string>
  posted: Set<string>
  toggle: (id: string) => void
}

/** Filter and grouping state, owned by the review view so the post bar can see it too. */
export interface FindingsWorkspace {
  filters: Filters
  setFilters: (filters: Filters) => void
  groupMode: GroupMode
  setGroupMode: (mode: GroupMode) => void
}

function FindingCard({
  finding,
  selection,
  open,
  active,
  onToggle,
  headId,
  link,
  inFileGroup
}: {
  finding: Finding
  selection?: FindingSelection
  open: boolean
  active: boolean
  onToggle: () => void
  headId: string
  link: string | null
  inFileGroup: boolean
}): React.JSX.Element {
  // In a file group the file is the heading, so only the line (and severity) are shown here.
  const loc = inFileGroup
    ? finding.line
      ? `line ${finding.line}`
      : null
    : finding.file
      ? finding.line
        ? `${finding.file}:${finding.line}`
        : finding.file
      : null
  const bodyId = `${headId}-body`
  const posted = selection?.posted.has(finding.id) ?? false
  const severity = SEVERITY_INFO[finding.severity]

  return (
    <article className={`finding-card ${open ? 'is-open' : ''} ${active ? 'is-active' : ''}`}>
      <div className="finding-row">
        {selection && (
          // A sibling of the toggle button: interactive elements can't nest inside a button.
          <input
            type="checkbox"
            className="finding-check"
            checked={selection.selected.has(finding.id)}
            onChange={() => selection.toggle(finding.id)}
            aria-label={`Include "${finding.title}" when posting to GitHub`}
          />
        )}
        <button
          type="button"
          id={headId}
          className="finding-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="chevron" aria-hidden="true">
            ›
          </span>
          {inFileGroup && (
            <span className={`dot dot-${severity.tone}`} title={severity.title}>
              <span className="sr-only">{severity.title}: </span>
            </span>
          )}
          <span className="finding-title">{finding.title}</span>
          {posted && <span className="pill pill-good">Posted</span>}
          {loc && <code className="location">{loc}</code>}
        </button>
      </div>
      {open && (
        <div className="finding-body" id={bodyId}>
          {finding.body && <Markdown>{finding.body}</Markdown>}
          {finding.suggestion &&
            (looksLikeProse(finding.suggestion) ? (
              <>
                <div className="suggestion-label">Suggested fix</div>
                <Markdown>{finding.suggestion}</Markdown>
              </>
            ) : (
              <>
                <div className="suggestion-label">Suggested change</div>
                <Markdown>{codeFence(finding.suggestion, languageForFile(finding.file))}</Markdown>
              </>
            ))}
          {link && (
            // Opened by the main process's external-link policy, never inside the app.
            <a className="finding-link" href={link} target="_blank" rel="noreferrer">
              Open on GitHub <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      )}
    </article>
  )
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

export function FindingsPanel({
  findings,
  selection,
  workspace,
  linkFor
}: {
  findings: Findings
  selection?: FindingSelection
  workspace: FindingsWorkspace
  /** GitHub link for a finding's line, or null when it can't be built. */
  linkFor?: (finding: Finding) => string | null
}): React.JSX.Element {
  const { filters, setFilters, groupMode, setGroupMode } = workspace
  const prefix = useId()
  const verdict = VERDICTS[findings.verdict]
  const all = findings.findings
  const counts = countBySeverity(all)

  const ctx = useMemo(
    () => ({
      selected: selection?.selected ?? new Set<string>(),
      posted: selection?.posted ?? new Set<string>()
    }),
    [selection?.selected, selection?.posted]
  )
  const visible = useMemo(() => filterFindings(all, filters, ctx), [all, filters, ctx])
  const groups = useMemo(() => groupFindings(visible, groupMode), [visible, groupMode])
  const order = useMemo(() => navigationOrder(groups), [groups])

  // Nits start collapsed; anything that needs action starts open.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(all.filter((f) => f.severity !== 'nit').map((f) => f.id))
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  const headId = (id: string): string => `${prefix}-finding-${id}`
  const toggle = (id: string): void => {
    setActiveId(id)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Expand/collapse all act on what's visible; hidden findings keep their state.
  const setVisibleExpanded = (open: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const id of order) {
        if (open) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const go = (direction: 1 | -1): void => {
    const id = stepFinding(order, activeId, direction)
    if (!id) return
    setActiveId(id)
    setExpanded((prev) => new Set(prev).add(id))
    const head = document.getElementById(headId(id))
    head?.focus()
    head?.scrollIntoView({ block: 'nearest' })
  }
  const goRef = useRef(go)
  useEffect(() => {
    goRef.current = go
  })

  // J / K move between findings, unless the user is typing or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || dialogOpen()) return
      const key = e.key.toLowerCase()
      if (key !== 'j' && key !== 'k') return
      e.preventDefault()
      goRef.current(key === 'j' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleSeverity = (severity: Finding['severity']): void => {
    const has = filters.severities.includes(severity)
    setFilters({
      ...filters,
      severities: has
        ? filters.severities.filter((s) => s !== severity)
        : [...filters.severities, severity]
    })
  }

  const filtering = isFiltering(filters)
  const extraFilters = (filters.selection !== 'all' ? 1 : 0) + (filters.posted !== 'all' ? 1 : 0)
  const position = activeId ? order.indexOf(activeId) : -1
  const filtersId = `${prefix}-filters`

  return (
    <div className="findings-panel">
      <section className="verdict summary-strip" aria-label="Verdict and counts">
        <div className="summary-row">
          <span className={`pill pill-${verdict.tone} pill-lg`}>{verdict.label}</span>
          {all.length > 0 && (
            <div className="severity-chips" role="group" aria-label="Show only these severities">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`severity-chip tone-${SEVERITY_INFO[s].tone}`}
                  aria-pressed={filters.severities.includes(s)}
                  disabled={counts[s] === 0 && !filters.severities.includes(s)}
                  onClick={() => toggleSeverity(s)}
                >
                  <span className={`dot dot-${SEVERITY_INFO[s].tone}`} aria-hidden="true" />
                  {SEVERITY_INFO[s].title}
                  <span className="count">{counts[s]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {findings.summary && (
          <p>
            <InlineMarkdown>{findings.summary}</InlineMarkdown>
          </p>
        )}
      </section>

      {findings.requirements.length > 0 && (
        <section>
          <h2 className="section-title">Does it do the task?</h2>
          <ul className="requirements">
            {findings.requirements.map((r, i) => {
              const status = REQUIREMENT_STATUS[r.status]
              return (
                <li key={i}>
                  <span className={`pill pill-${status.tone}`}>{status.label}</span>
                  <div>
                    <div>
                      <InlineMarkdown>{r.text}</InlineMarkdown>
                    </div>
                    {r.notes && (
                      <div className="muted small">
                        <InlineMarkdown>{r.notes}</InlineMarkdown>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {all.length === 0 ? (
        <p className="muted">No issues found.</p>
      ) : (
        <section className="findings-workspace" aria-label="Findings">
          <div className="findings-toolbar">
            <input
              type="search"
              className="findings-search"
              value={filters.query}
              placeholder="Search findings"
              aria-label="Search findings by title, text, file or suggested change"
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
              View
              {extraFilters > 0 ? ` · ${extraFilters} filter${extraFilters > 1 ? 's' : ''}` : ''}
            </button>
          </div>

          {showFilters && (
            <div className="findings-filters" id={filtersId}>
              <fieldset className="segmented">
                <legend>Group by</legend>
                {(
                  [
                    ['severity', 'Severity'],
                    ['file', 'File']
                  ] as const
                ).map(([mode, label]) => (
                  <label key={mode} className={groupMode === mode ? 'is-active' : ''}>
                    <input
                      type="radio"
                      name={`${prefix}-group`}
                      checked={groupMode === mode}
                      onChange={() => setGroupMode(mode)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              {selection && (
                <>
                  <label className="filter-select">
                    Selection
                    <select
                      value={filters.selection}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          selection: e.target.value as Filters['selection']
                        })
                      }
                    >
                      <option value="all">All</option>
                      <option value="selected">Selected</option>
                      <option value="unselected">Not selected</option>
                    </select>
                  </label>
                  <label className="filter-select">
                    Posting
                    <select
                      value={filters.posted}
                      onChange={(e) =>
                        setFilters({ ...filters, posted: e.target.value as Filters['posted'] })
                      }
                    >
                      <option value="all">All</option>
                      <option value="unposted">Not posted</option>
                      <option value="posted">Posted</option>
                    </select>
                  </label>
                </>
              )}
            </div>
          )}

          <div className="findings-nav">
            <span className="findings-count" role="status" aria-live="polite">
              {filtering ? `Showing ${visible.length} of ${all.length}` : `${all.length} findings`}
              {position >= 0 && ` · ${position + 1}/${order.length}`}
            </span>
            <div className="findings-nav-buttons">
              <button
                type="button"
                className="link-button"
                disabled={order.length === 0}
                onClick={() => setVisibleExpanded(true)}
              >
                Expand all
              </button>
              <button
                type="button"
                className="link-button"
                disabled={order.length === 0}
                onClick={() => setVisibleExpanded(false)}
              >
                Collapse all
              </button>
              <button
                type="button"
                className="icon-button nav-step"
                aria-label="Previous finding"
                title="Previous finding (K)"
                disabled={order.length === 0}
                onClick={() => go(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-button nav-step"
                aria-label="Next finding"
                title="Next finding (J)"
                disabled={order.length === 0}
                onClick={() => go(1)}
              >
                ↓
              </button>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="filter-empty">
              <p>
                No findings match: {describeFilters(filters).join(' · ')}. Filters never change
                which findings are selected for posting.
              </p>
              <button
                type="button"
                className="secondary small-button"
                onClick={() => setFilters(NO_FILTERS)}
              >
                Clear filters
              </button>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="finding-group" aria-label={g.title}>
                <h2 className={`section-title ${g.file !== undefined ? 'file-title' : ''}`}>
                  {g.tone && <span className={`dot dot-${g.tone}`} aria-hidden="true" />}
                  {g.file ? <code title={g.file}>{g.file}</code> : g.title}{' '}
                  <span className="count">{g.items.length}</span>
                </h2>
                <div className="finding-list">
                  {g.items.map((f) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      selection={selection}
                      open={expanded.has(f.id)}
                      active={activeId === f.id}
                      onToggle={() => toggle(f.id)}
                      headId={headId(f.id)}
                      link={linkFor?.(f) ?? null}
                      inFileGroup={groupMode === 'file'}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </section>
      )}
    </div>
  )
}
