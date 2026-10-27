import { useEffect, useState } from 'react'
import type { ReviewEvent } from '@shared/ipc'
import type { ReviewInput } from '@shared/validate'
import { ReviewForm } from './components/ReviewForm'

// Temporary wiring so a review can be run end to end; Prompt 4 replaces this with the review view.
function App(): React.JSX.Element {
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  useEffect(
    () =>
      window.api.onReviewEvent((event: ReviewEvent) => {
        if (event.reviewId !== reviewId) return
        console.log('review event', event)
        const line =
          event.type === 'status'
            ? event.message
            : event.type === 'tool'
              ? event.label
              : event.type === 'text'
                ? null
                : event.type === 'done'
                  ? `Done: ${event.result.findings?.verdict ?? 'no findings block'}`
                  : event.type === 'error'
                    ? `Error: ${event.message}`
                    : 'Cancelled'
        if (line) setLog((l) => [...l, line])
        if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
          setRunning(false)
        }
      }),
    [reviewId]
  )

  const start = async (input: ReviewInput): Promise<void> => {
    setLog([])
    setRunning(true)
    const res = await window.api.startReview(input)
    if (res.ok) setReviewId(res.reviewId)
    else {
      setLog([`Error: ${res.error}`])
      setRunning(false)
    }
  }

  return (
    <main className="shell">
      <header className="app-header">
        <h1>PR Hub</h1>
        <p className="muted">Review a pull request against its task.</p>
      </header>
      <ReviewForm onSubmit={start} busy={running} />
      {log.length > 0 && (
        <section className="muted" aria-live="polite">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {running && reviewId && (
            <button onClick={() => window.api.cancelReview(reviewId)}>Cancel</button>
          )}
        </section>
      )}
    </main>
  )
}

export default App
