import { useState } from 'react'
import type { ReplayVariant } from '@shared/ipc'
import type { ReviewInput } from '@shared/validate'
import { ReviewForm } from './components/ReviewForm'
import { ReviewView } from './components/ReviewView'
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

  if (review.state) {
    return (
      <ReviewView
        state={review.state}
        onBack={review.reset}
        onCancel={review.cancel}
        onRetry={review.retry}
      />
    )
  }

  return (
    <main className="shell">
      <header className="app-header">
        <h1>PR Hub</h1>
        <p className="muted">Review a pull request against its task.</p>
      </header>
      <ReviewForm
        initialValues={lastInput}
        onSubmit={(input) => {
          setLastInput(input)
          review.start(input)
        }}
      />
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
