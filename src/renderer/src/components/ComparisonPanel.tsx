import { useId, useState } from 'react'
import type { Finding, Findings } from '@shared/findings'
import {
  effectiveStatus,
  expandOverrides,
  LIFECYCLE_LABELS,
  lifecycleCounts,
  overrideChoices,
  type Comparison,
  type ComparisonItem,
  type Lifecycle,
  type LocationEvidence,
  type Override
} from '@shared/incremental'
import { SEVERITY_INFO } from '../review/findingsView'
import { shortSha } from '../review/historyView'
import { LIFECYCLE_TONE, VERDICTS } from '../review/verdict'

// Uncertain items first: they are the ones waiting for a decision.
const ORDER: Lifecycle[] = ['unable_to_verify', 'new', 'still_present', 'resolved']

const LOCATION_TEXT: Record<LocationEvidence['kind'], string> = {
  untouched: 'That line was not edited',
  changed: 'The code there changed',
  deleted: 'The file was deleted',
  no_location: 'Not tied to a line',
  unknown: "The changes between the commits couldn't be read"
}

const MODEL_TEXT: Record<string, string> = {
  still_present: 'still present',
  resolved: 'resolved',
  unable_to_verify: 'unable to verify'
}

function Verdict({ verdict }: { verdict: string | null }): React.JSX.Element {
  const info = verdict ? VERDICTS[verdict as Findings['verdict']] : null
  return info ? (
    <span className={`pill pill-${info.tone}`}>{info.label}</span>
  ) : (
    <span className="pill pill-muted">No verdict</span>
  )
}

function Item({
  item,
  status,
  overridden,
  title,
  severity,
  counterpart,
  onOverride
}: {
  item: ComparisonItem
  status: Lifecycle
  overridden: boolean
  title: string
  severity: Finding['severity'] | null
  counterpart: string | null
  onOverride?: (key: string, value: Override | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(status === 'unable_to_verify')
  const id = useId()
  const { evidence } = item
  const choices = overrideChoices(item)
  const sev = severity ? SEVERITY_INFO[severity] : null

  return (
    <article className={`finding-card comparison-item ${open ? 'is-open' : ''}`}>
      <div className="finding-row">
        <button
          type="button"
          className="finding-head"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="chevron" aria-hidden="true">
            ›
          </span>
          {sev && (
            <span className={`dot dot-${sev.tone}`} title={sev.title}>
              <span className="sr-only">{sev.title}: </span>
            </span>
          )}
          <span className="finding-title">{title}</span>
          <span className={`pill pill-${LIFECYCLE_TONE[status]}`}>
            {LIFECYCLE_LABELS[status]}
            {overridden && <span className="sr-only"> (your decision)</span>}
          </span>
          {overridden && (
            <span className="muted small" aria-hidden="true">
              yours
            </span>
          )}
        </button>
      </div>
      {open && (
        <div className="finding-body comparison-evidence" id={`${id}-body`}>
          <p>{evidence.reason}</p>
          <dl className="post-facts">
            {evidence.model && (
              <>
                <dt>Review said</dt>
                <dd>
                  {MODEL_TEXT[evidence.model.status] ?? evidence.model.status}
                  {evidence.model.note && <span className="muted">: {evidence.model.note}</span>}
                </dd>
              </>
            )}
            <dt>Location</dt>
            <dd>
              {LOCATION_TEXT[evidence.location.kind]}
              {evidence.location.from && (
                <>
                  {' · '}
                  <code>{evidence.location.from}</code>
                  {evidence.location.to && evidence.location.to !== evidence.location.from && (
                    <>
                      {' → '}
                      <code>{evidence.location.to}</code>
                    </>
                  )}
                </>
              )}
              {!evidence.location.from && evidence.location.to && (
                <>
                  {' · '}
                  <code>{evidence.location.to}</code>
                </>
              )}
            </dd>
            {evidence.similarity !== null && (
              <>
                <dt>Text overlap</dt>
                <dd>{Math.round(evidence.similarity * 100)}%</dd>
              </>
            )}
            {counterpart && (
              <>
                <dt>{item.previous ? 'Possible match now' : 'Possible earlier finding'}</dt>
                <dd>{counterpart}</dd>
              </>
            )}
            {item.previousPosted && (
              <>
                <dt>GitHub</dt>
                <dd>Posted from an earlier review</dd>
              </>
            )}
          </dl>
          {choices.length > 0 && onOverride && (
            <div className="override" role="group" aria-label={`Your decision for "${title}"`}>
              <span className="muted small">Your call (stays on this Mac):</span>
              {choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="secondary small-button"
                  aria-pressed={status === choice && overridden}
                  onClick={() => onOverride(item.key, choice)}
                >
                  {LIFECYCLE_LABELS[choice]}
                </button>
              ))}
              {overridden && (
                <button
                  type="button"
                  className="link-button small"
                  onClick={() => onOverride(item.key, null)}
                >
                  Undo
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export function ComparisonPanel({
  comparison,
  overrides,
  headSha,
  verdict,
  findings,
  onOverride
}: {
  comparison: Comparison
  overrides: Record<string, Override>
  headSha: string | null
  verdict: string | null
  findings: readonly Finding[]
  /** Absent when the review can't be changed (fixture replays). */
  onOverride?: (key: string, value: Override | null) => void
}): React.JSX.Element {
  const counts = lifecycleCounts(comparison, overrides)
  const expanded = expandOverrides(comparison, overrides)
  const current = new Map(findings.map((f) => [f.id, f]))
  const previous = new Map(
    comparison.items.filter((i) => i.previous).map((i) => [i.previous!.id, i.previous!])
  )
  const titleOf = (item: ComparisonItem): string =>
    item.previous?.title ?? current.get(item.currentId ?? '')?.title ?? 'Finding'
  const counterpartOf = (item: ComparisonItem): string | null => {
    if (!item.suggestedId) return null
    return item.previous
      ? (current.get(item.suggestedId)?.title ?? null)
      : (previous.get(item.suggestedId)?.title ?? null)
  }

  return (
    <div className="findings-panel comparison-panel">
      <section className="verdict summary-strip" aria-label="Comparison with the previous review">
        <p className="comparison-commits">
          <code title={comparison.comparedSha}>{shortSha(comparison.comparedSha)}</code>
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> to </span>
          <code title={headSha ?? undefined}>{shortSha(headSha) ?? 'new head'}</code>
        </p>
        <p className="comparison-verdicts">
          <Verdict verdict={comparison.previousVerdict} />
          <span aria-hidden="true">→</span>
          <span className="sr-only">now</span>
          <Verdict verdict={verdict} />
        </p>
        <div className="severity-chips" aria-label="Counts">
          {ORDER.map((s) => (
            <span key={s} className={`severity-chip tone-${LIFECYCLE_TONE[s]}`}>
              <span className={`dot dot-${LIFECYCLE_TONE[s]}`} aria-hidden="true" />
              {LIFECYCLE_LABELS[s]}
              <span className="count">{counts[s]}</span>
            </span>
          ))}
        </div>
        {!comparison.modelCompared && (
          <p className="notice" role="note">
            The review didn&apos;t include its comparison with the previous findings, so they show
            as Unable to verify. The code evidence below still applies.
          </p>
        )}
      </section>

      {ORDER.map((group) => {
        const items = comparison.items.filter((i) => {
          const status = effectiveStatus(i, expanded)
          // A repeat settled as still present is shown once, on its previous finding.
          return status === group && !(status === 'still_present' && !i.previous)
        })
        if (items.length === 0) return null
        return (
          <section key={group} className="finding-group" aria-label={LIFECYCLE_LABELS[group]}>
            <h2 className="section-title">
              <span className={`dot dot-${LIFECYCLE_TONE[group]}`} aria-hidden="true" />
              {LIFECYCLE_LABELS[group]} <span className="count">{items.length}</span>
            </h2>
            <div className="finding-list">
              {items.map((item) => (
                <Item
                  key={item.key}
                  item={item}
                  status={group}
                  overridden={item.key in expanded && item.status === 'unable_to_verify'}
                  title={titleOf(item)}
                  severity={
                    item.previous?.severity ?? current.get(item.currentId ?? '')?.severity ?? null
                  }
                  counterpart={counterpartOf(item)}
                  onOverride={onOverride}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
