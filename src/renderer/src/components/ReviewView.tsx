import { useEffect, useMemo, useRef, useState } from 'react'
import type { Findings } from '@shared/findings'
import type { PostRecord } from '@shared/github'
import { isTerminal, type ReviewState } from '../review/state'
import { formatCost, formatDuration, prLabel } from '../review/format'
import {
  filterFindings,
  githubFileUrl,
  NO_FILTERS,
  type Filters,
  type GroupMode
} from '../review/findingsView'
import { sessionPrefs } from '../review/sessionPrefs'
import { dialogOpen } from '../review/keyboard'
import { useSettings } from '../review/useSettings'
import { FindingsPanel, type FindingSelection, type FindingsWorkspace } from './FindingsPanel'
import { Markdown } from './Markdown'
import { PinButton } from './PinButton'
import { PostDialog } from './PostDialog'

interface Props {
  state: ReviewState
  onBack: () => void
  onCancel: () => void
  onRetry: () => void
  onPosted: (record: PostRecord) => void
}

// Blocking and should-fix findings that haven't been posted yet; nits are opt-in.
function defaultSelection(findings: Findings | null, posted: Set<string>): Set<string> {
  return new Set(
    (findings?.findings ?? [])
      .filter((f) => f.severity !== 'nit' && !posted.has(f.id))
      .map((f) => f.id)
  )
}

type Tab = 'findings' | 'markdown'

const TABS = [
  ['findings', 'Findings'],
  ['markdown', 'Full review']
] as const

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function Progress({ state }: { state: ReviewState }): React.JSX.Element {
  const steps =
    state.steps.length > 0 ? state.steps : [{ id: -1, kind: 'status', label: 'Starting…' }]
  return (
    <section className="progress" aria-live="polite" aria-label="Review progress">
      <ol className="steps">
        {steps.map((step, i) => {
          const current = i === steps.length - 1
          return (
            <li key={step.id} className={current ? 'is-current' : 'is-done'}>
              <span className={current ? 'spinner' : 'tick'} aria-hidden="true" />
              <span>{step.label}</span>
            </li>
          )
        })}
      </ol>
      <p className="muted small">
        Reviews usually take a few minutes. You can keep this window open in the corner.
      </p>
    </section>
  )
}

function Outcome({
  state,
  tab,
  setTab,
  selection,
  workspace
}: {
  state: ReviewState
  tab: Tab
  setTab: (tab: Tab) => void
  selection?: FindingSelection
  workspace: FindingsWorkspace
}): React.JSX.Element | null {
  const result = state.result
  if (!result) return null

  if (!result.findings) {
    return (
      <>
        <p className="notice" role="note">
          Structured findings weren&apos;t available for this review, so the full text is shown.
          {result.findingsError && <span className="muted small"> ({result.findingsError})</span>}
        </p>
        <Markdown>{result.markdown}</Markdown>
      </>
    )
  }

  // ARIA tabs pattern: one tab stop for the group, arrow keys move between tabs.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')
      return
    e.preventDefault()
    const next: Tab =
      e.key === 'Home'
        ? 'findings'
        : e.key === 'End'
          ? 'markdown'
          : tab === 'findings'
            ? 'markdown'
            : 'findings'
    setTab(next)
    document.getElementById(`tab-${next}`)?.focus()
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Review output" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'is-active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'findings' ? (
          <FindingsPanel
            findings={result.findings}
            selection={selection}
            workspace={workspace}
            linkFor={(f) => githubFileUrl(state.input.prUrl, state.headSha, f.file, f.line)}
          />
        ) : (
          <Markdown>{result.markdown}</Markdown>
        )}
      </div>
    </>
  )
}

export function ReviewView({
  state,
  onBack,
  onCancel,
  onRetry,
  onPosted
}: Props): React.JSX.Element {
  const running = !isTerminal(state.phase)
  const now = useNow(running)
  const elapsed = (state.endedAt ?? now) - state.startedAt
  const result = state.result
  const cost = formatCost(result?.costUsd ?? null)
  const [tab, setTab] = useState<Tab>('findings')
  const bodyRef = useRef<HTMLDivElement>(null)
  const defaultMode = useSettings()?.defaultPostMode ?? 'comment'

  // Posting needs a saved review with structured findings; fixture replays are never saved.
  const findings = result?.findings ?? null
  const canPost = state.phase === 'done' && !!findings && !state.isReplay && !!state.reviewId
  const postedIds = useMemo(
    () => new Set(state.posted.flatMap((p) => p.findingIds)),
    [state.posted]
  )
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const selected = picked ?? defaultSelection(findings, postedIds)
  // Filters only change what's shown, never what's selected; the post bar says how many
  // selected findings are currently hidden.
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [groupMode, setGroupModeState] = useState<GroupMode>(() => sessionPrefs.groupMode)
  const workspace: FindingsWorkspace = {
    filters,
    setFilters,
    groupMode,
    setGroupMode: (mode) => {
      sessionPrefs.groupMode = mode
      setGroupModeState(mode)
    }
  }
  const visibleIds = new Set(
    filterFindings(findings?.findings ?? [], filters, { selected, posted: postedIds }).map(
      (f) => f.id
    )
  )
  const hiddenSelected = [...selected].filter((id) => !visibleIds.has(id)).length
  // Fixed when the dialog opens so its preview can't change underneath the user.
  const [dialogIds, setDialogIds] = useState<string[] | null>(null)
  const selection: FindingSelection | undefined = canPost
    ? {
        selected,
        posted: postedIds,
        toggle: (id) => {
          const next = new Set(selected)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          setPicked(next)
        }
      }
    : undefined

  // Each phase and tab starts at the top, not wherever the previous content was scrolled.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [state.phase, tab])

  const back = (): void => {
    if (running && !window.confirm('A review is still running. Cancel it and go back?')) return
    onBack()
  }
  const backRef = useRef(back)
  useEffect(() => {
    backRef.current = back
  })

  // Esc goes back, unless a dialog is open (Esc closes that instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !dialogOpen()) backRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Move focus to the review's title so keyboard and screen-reader users land in the new view.
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="review-view">
      <header className="review-header">
        <button
          type="button"
          className="icon-button"
          onClick={back}
          aria-label="Back to the form"
          title="Back (Esc)"
        >
          ←
        </button>
        <div className="review-heading">
          <h1 ref={headingRef} tabIndex={-1} title={state.input.title}>
            {state.input.title}
          </h1>
          <a className="pr-ref" href={state.input.prUrl} target="_blank" rel="noreferrer">
            {prLabel(state.input.prUrl)}
          </a>
        </div>
        {running && (
          <button type="button" className="secondary" onClick={onCancel} disabled={!state.reviewId}>
            Cancel
          </button>
        )}
        {state.phase === 'done' && (
          <button
            type="button"
            className="secondary"
            onClick={onRetry}
            title="Review this PR again with the same task"
          >
            Re-run
          </button>
        )}
        <PinButton />
      </header>

      <div className="review-body" ref={bodyRef}>
        {running && <Progress state={state} />}

        {state.phase === 'done' && (
          <Outcome
            state={state}
            tab={tab}
            setTab={setTab}
            selection={selection}
            workspace={workspace}
          />
        )}

        {state.phase === 'error' && (
          <section className="empty-state" role="alert">
            <h2>Review failed</h2>
            <pre className="error-detail">{state.error}</pre>
            <div className="row">
              <button type="button" className="primary" onClick={onRetry}>
                Retry
              </button>
              <button type="button" className="secondary" onClick={onBack}>
                Edit task
              </button>
            </div>
          </section>
        )}

        {state.phase === 'cancelled' && (
          <section className="empty-state">
            <h2>Review cancelled</h2>
            <div className="row">
              <button type="button" className="primary" onClick={onRetry}>
                Run again
              </button>
              <button type="button" className="secondary" onClick={onBack}>
                Edit task
              </button>
            </div>
          </section>
        )}
      </div>

      {canPost && tab === 'findings' && findings!.findings.length > 0 && (
        <div className="post-bar">
          <span className="muted small">
            {selected.size} of {findings!.findings.length} selected
            {hiddenSelected > 0 && ` · ${hiddenSelected} hidden by filters`}
            {postedIds.size > 0 && ` · ${postedIds.size} posted`}
          </span>
          <button
            type="button"
            className="primary"
            disabled={selected.size === 0}
            onClick={() => setDialogIds([...selected])}
          >
            Post to GitHub…
          </button>
        </div>
      )}

      {dialogIds && state.reviewId && findings && (
        <PostDialog
          reviewId={state.reviewId}
          prUrl={state.input.prUrl}
          findings={findings.findings}
          selectedIds={dialogIds}
          defaultMode={defaultMode}
          onClose={() => setDialogIds(null)}
          onPosted={(record) => {
            onPosted(record)
            const next = new Set(selected)
            record.findingIds.forEach((id) => next.delete(id))
            setPicked(next)
          }}
        />
      )}

      <footer className="review-footer">
        <span>
          {running ? 'Elapsed ' : ''}
          {formatDuration(result?.durationMs || elapsed)}
          {cost && ` · ${cost}`}
          {state.isReplay && ' · replay'}
          {state.fromHistory &&
            ` · ${new Date(state.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
        </span>
        {result && result.deniedTools.length > 0 && (
          <span className="warn-text" title={result.deniedTools.join('\n')}>
            {result.deniedTools.length} tool call(s) blocked
          </span>
        )}
      </footer>
    </div>
  )
}
