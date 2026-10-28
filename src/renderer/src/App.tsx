import { useEffect, useRef, useState } from 'react'
import type { ReplayVariant } from '@shared/ipc'
import type { ReviewInput } from '@shared/validate'
import { PinButton } from './components/PinButton'
import { RecentReviews } from './components/RecentReviews'
import { ReviewForm } from './components/ReviewForm'
import { ReviewView } from './components/ReviewView'
import { dialogOpen } from './review/keyboard'
import { isTerminal } from './review/state'
import { useReview } from './review/useReview'

const REPLAYS: Array<[ReplayVariant, string]> = [
  ['full', 'full'],
  ['no-findings', 'no findings'],
  ['error', 'error']
]

function App(): React.JSX.Element {
  const review = useReview()
  // The last real task, so "back" returns to a filled-in form for editing or re-running.
  const [lastInput, setLastInput] = useState<ReviewInput | undefined>()
  // Bumped to remount (and so clear) the form for a new review.
  const [formKey, setFormKey] = useState(0)

  const newReview = (): void => {
    const state = review.state
    if (
      state &&
      !isTerminal(state.phase) &&
      !state.isReplay &&
      !window.confirm('A review is still running. Cancel it and start a new one?')
    ) {
      return
    }
    review.reset()
    setLastInput(undefined)
    setFormKey((k) => k + 1)
  }
  // Listeners below are registered once; this ref always points at the current handler.
  const newReviewRef = useRef(newReview)
  useEffect(() => {
    newReviewRef.current = newReview
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'n' && (e.metaKey || e.ctrlKey) && !dialogOpen()) {
        e.preventDefault()
        newReviewRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    const unsubscribe = window.api.onNewReview(() => newReviewRef.current())
    return () => {
      window.removeEventListener('keydown', onKey)
      unsubscribe()
    }
  }, [])

  if (review.state) {
    return (
      <ReviewView
        // A fresh view per review, so selection and tab state never leak between reviews.
        key={review.state.requestId}
        state={review.state}
        onBack={() => {
          // Back from a saved review pre-fills the form with that task, ready to edit or re-run.
          if (review.state?.fromHistory) setLastInput(review.state.input)
          review.reset()
        }}
        onCancel={review.cancel}
        onRetry={review.retry}
        onPosted={review.markPosted}
      />
    )
  }

  return (
    <main className="shell">
      <header className="app-header">
        <div>
          <h1>PR Hub</h1>
          <p className="muted">Review a pull request against its task.</p>
        </div>
        <PinButton />
      </header>
      <ReviewForm
        key={formKey}
        initialValues={lastInput}
        onSubmit={(input) => {
          setLastInput(input)
          review.start(input)
        }}
      />
      <RecentReviews onOpen={(id) => void review.open(id)} />
      {import.meta.env.DEV && (
        <p className="dev-tools muted small">
          Dev · replay fixture:{' '}
          {REPLAYS.map(([variant, label]) => (
            <button
              key={variant}
              type="button"
              className="link-button"
              onClick={() => review.replay(variant)}
            >
              {label}
            </button>
          ))}
        </p>
      )}
    </main>
  )
}

export default App
