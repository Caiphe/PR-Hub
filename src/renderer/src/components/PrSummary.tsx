import { changeSummary, intakeWarnings } from '../review/intake'
import type { Inspection } from '../review/usePrInspection'
import { prLabel } from '../review/format'

// The PR at a glance before reviewing. Title, author and branch names come from the PR author,
// so they're rendered as plain text only (never as Markdown or HTML).
export function PrSummary({
  inspection,
  onRetry
}: {
  inspection: Inspection
  onRetry: () => void
}): React.JSX.Element {
  if (inspection.status === 'loading') {
    return (
      <div className="pr-summary is-loading" aria-live="polite">
        <span className="spinner inline-spinner" aria-hidden="true" /> Looking up{' '}
        {prLabel(inspection.url)}…
      </div>
    )
  }

  if (inspection.status === 'error') {
    const problem = inspection.problem
    return (
      <div className="pr-summary is-error" role="status">
        <p className="pr-summary-error">
          <strong>Couldn&apos;t load PR details.</strong> {problem?.message ?? inspection.error} You
          can still fill in the task yourself.
        </p>
        {problem && problem.actions.length > 0 && (
          <ul className="pr-summary-actions">
            {problem.actions.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        )}
        <div className="pr-summary-foot">
          {problem?.detail && (
            <details className="gh-problem-detail">
              <summary>Error details</summary>
              <pre>{problem.detail}</pre>
            </details>
          )}
          <button type="button" className="link-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { pr } = inspection
  const warnings = intakeWarnings(pr)
  const size = changeSummary(pr)
  return (
    <section className="pr-summary" aria-label="Pull request">
      <div className="pr-summary-head">
        <span className="pr-summary-ref">{prLabel(pr.url)}</span>
        {pr.draft && <span className="pill pill-muted">Draft</span>}
        {pr.state !== 'open' && (
          <span className={`pill ${pr.state === 'merged' ? 'pill-info' : 'pill-muted'}`}>
            {pr.state === 'merged' ? 'Merged' : 'Closed'}
          </span>
        )}
      </div>
      <p className="pr-summary-title" title={pr.title}>
        {pr.title}
      </p>
      <p className="pr-summary-meta">
        {pr.author && <span>@{pr.author}</span>}
        <span className="pr-summary-branches" title={`${pr.baseRef} ← ${pr.headLabel}`}>
          <code>{pr.baseRef}</code> ← <code>{pr.headLabel}</code>
        </span>
        {size && <span>{size}</span>}
      </p>
      {warnings.map((w) => (
        <p key={w} className="notice pr-summary-warning">
          {w}
        </p>
      ))}
      {pr.via === 'public_api' && (
        <p className="pr-summary-note">Read from GitHub&apos;s public API (no gh login).</p>
      )}
    </section>
  )
}
