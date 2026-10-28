import { useEffect, useRef, useState } from 'react'
import { isTerminal, type ReviewState } from '../review/state'
import { formatCost, formatDuration, prLabel } from '../review/format'
import { FindingsPanel } from './FindingsPanel'
import { Markdown } from './Markdown'

interface Props {
  state: ReviewState
  onBack: () => void
  onCancel: () => void
  onRetry: () => void
}

type Tab = 'findings' | 'markdown'

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
  setTab
}: {
  state: ReviewState
  tab: Tab
  setTab: (tab: Tab) => void
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

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Review output">
        {(
          [
            ['findings', 'Findings'],
            ['markdown', 'Full review']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            className={tab === id ? 'is-active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'findings' ? (
          <FindingsPanel findings={result.findings} />
        ) : (
          <Markdown>{result.markdown}</Markdown>
        )}
      </div>
    </>
  )
}

export function ReviewView({ state, onBack, onCancel, onRetry }: Props): React.JSX.Element {
  const running = !isTerminal(state.phase)
  const now = useNow(running)
  const elapsed = (state.endedAt ?? now) - state.startedAt
  const result = state.result
  const cost = formatCost(result?.costUsd ?? null)
  const [tab, setTab] = useState<Tab>('findings')
  const bodyRef = useRef<HTMLDivElement>(null)

  // Each phase and tab starts at the top, not wherever the previous content was scrolled.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [state.phase, tab])

  const back = (): void => {
    if (running && !window.confirm('A review is still running. Cancel it and go back?')) return
    onBack()
  }

  return (
    <div className="review-view">
      <header className="review-header">
        <button type="button" className="icon-button" onClick={back} aria-label="Back to the form">
          ←
        </button>
        <div className="review-heading">
          <h1 title={state.input.title}>{state.input.title}</h1>
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
      </header>

      <div className="review-body" ref={bodyRef}>
        {running && <Progress state={state} />}

        {state.phase === 'done' && <Outcome state={state} tab={tab} setTab={setTab} />}

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
