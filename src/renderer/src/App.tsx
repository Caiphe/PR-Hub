import { useEffect, useRef, useState } from 'react'
import { REPLAY_VARIANTS, type ReplayVariant } from '@shared/ipc'
import type { ReviewInput } from '@shared/validate'
import { HistoryView } from './components/HistoryView'
import { PinButton } from './components/PinButton'
import { RecentReviews } from './components/RecentReviews'
import { ReviewForm } from './components/ReviewForm'
import { ReviewView } from './components/ReviewView'
import { BrandMark, SettingsIcon } from './components/InterfaceIcons'
import { SettingsView } from './components/SettingsView'
import { dialogOpen } from './review/keyboard'
import { isTerminal } from './review/state'
import { useReview } from './review/useReview'

const REPLAY_LABELS: Record<ReplayVariant, string> = {
  full: 'full',
  'no-findings': 'no findings',
  error: 'error',
  incremental: 'incremental',
  fallback: 'fallback'
}

function App(): React.JSX.Element {
  const review = useReview()
  // The last real task, so "back" returns to a filled-in form for editing or re-running.
  const [lastInput, setLastInput] = useState<ReviewInput | undefined>()
  // Bumped to remount (and so clear) the form for a new review.
  const [formKey, setFormKey] = useState(0)
  // The History view replaces the form; a review opened from it returns there on back.
  const [view, setView] = useState<'form' | 'history'>('form')
  // Settings opens over whatever is showing (even a running review) and Back returns to it.
  const [showSettings, setShowSettings] = useState(false)

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
    setShowSettings(false)
    setView('form')
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
    const unsubscribeSettings = window.api.onOpenSettings(() => setShowSettings(true))
    return () => {
      window.removeEventListener('keydown', onKey)
      unsubscribe()
      unsubscribeSettings()
    }
  }, [])

  if (showSettings) return <SettingsView onBack={() => setShowSettings(false)} />

  if (review.state) {
    return (
      <ReviewView
        // A fresh view per review, so selection and tab state never leak between reviews.
        key={review.state.requestId}
        state={review.state}
        onBack={() => {
          // Back from a saved review pre-fills the form with that task, ready to edit or re-run
          // (or returns to History, when it was opened there).
          if (review.state?.fromHistory && view === 'form') setLastInput(review.state.input)
          review.reset()
        }}
        onCancel={review.cancel}
        onRetry={review.retry}
        onPosted={review.markPosted}
        onOverride={review.setOverride}
      />
    )
  }

  if (view === 'history') {
    return <HistoryView onBack={() => setView('form')} onOpen={(id) => void review.open(id)} />
  }

  return (
    <main className="shell">
      <header className="app-header">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <h1>PR Hub</h1>
            <p className="muted">Review a pull request against its task.</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon />
          </button>
          <PinButton />
        </div>
      </header>
      <ReviewForm
        key={formKey}
        initialValues={lastInput}
        onSubmit={(input, options) => {
          setLastInput(input)
          review.start(input, options)
        }}
      />
      <RecentReviews onOpen={(id) => void review.open(id)} onShowAll={() => setView('history')} />
      {import.meta.env.DEV && (
        <p className="dev-tools muted small">
          Dev · replay fixture:{' '}
          {REPLAY_VARIANTS.map((variant) => (
            <button
              key={variant}
              type="button"
              className="link-button"
              onClick={() => review.replay(variant)}
            >
              {REPLAY_LABELS[variant]}
            </button>
          ))}
        </p>
      )}
    </main>
  )
}

export default App
