import { useId, useState } from 'react'
import type { Findings } from '@shared/findings'
import { shortSha } from '../review/historyView'
import { formatRelative } from '../review/format'
import type { OfferState, ReviewMode } from '../review/useIncrementalOffer'
import { VERDICTS } from '../review/verdict'

// Shown under the PR summary when this PR was reviewed before: choose between reviewing only
// what changed since then and a full re-review.
export function PreviousReview({
  offer,
  mode,
  onMode
}: {
  offer: OfferState | null
  mode: ReviewMode
  onMode: (mode: ReviewMode) => void
}): React.JSX.Element | null {
  const id = useId()
  // "Time ago" measured from when the card appeared, like the recent list.
  const [now] = useState(() => Date.now())
  if (offer?.status !== 'ready' || !offer.offer.parent) return null
  const { parent, available, message } = offer.offer
  const sha = shortSha(parent.headSha)
  const verdict = parent.verdict ? VERDICTS[parent.verdict as Findings['verdict']] : null
  const counts = parent.counts
  const incremental = available && mode === 'incremental'

  return (
    <fieldset className="field task-source previous-review">
      <legend>Previously reviewed</legend>
      <p className="previous-meta">
        {formatRelative(parent.startedAt, now)}
        {sha && (
          <>
            {' at '}
            <code>{sha}</code>
          </>
        )}
        {verdict && <span className={`pill pill-${verdict.tone}`}>{verdict.label}</span>}
        {counts && (
          <span className="muted small">
            {counts.blocking} blocking · {counts.should_fix} should fix · {counts.nit} nits
          </span>
        )}
      </p>
      <label className="task-source-option">
        <input
          type="radio"
          name={`${id}-mode`}
          checked={incremental}
          disabled={!available}
          aria-describedby={`${id}-why`}
          onChange={() => onMode('incremental')}
        />
        <span>
          Review changes since {sha ?? 'the previous review'}
          <span className="muted small"> · new, still present and resolved findings</span>
        </span>
      </label>
      <label className="task-source-option">
        <input
          type="radio"
          name={`${id}-mode`}
          checked={!incremental}
          onChange={() => onMode('full')}
        />
        <span>Full re-review</span>
      </label>
      {message && (
        <p className="field-help" id={`${id}-why`}>
          {message}
        </p>
      )}
    </fieldset>
  )
}
