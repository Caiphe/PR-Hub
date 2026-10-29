import { useEffect, useId, useRef, useState } from 'react'
import type { BrowserStatus } from '@shared/ipc'
import {
  BROWSER_LABELS,
  BROWSERS,
  diffSettings,
  HISTORY_RETENTION,
  MODEL_PATTERN,
  TIMEOUT_MINUTES,
  type Settings
} from '@shared/settings'
import { dialogOpen } from '../review/keyboard'
import { useSettings } from '../review/useSettings'

/** A whole number within range, or an error message. */
function parseWhole(text: string, range: { min: number; max: number }): number | string {
  const n = Number(text.trim())
  if (text.trim() === '' || !Number.isInteger(n) || n < range.min || n > range.max) {
    return `Enter a whole number from ${range.min} to ${range.max}.`
  }
  return n
}

/**
 * A text or number field saved on blur or Enter (not on every keystroke). Esc with unsaved
 * text puts the saved value back instead of leaving the view.
 */
function DraftField({
  label,
  hint,
  value,
  inputMode,
  placeholder,
  suffix,
  validate,
  onSave
}: {
  label: string
  hint: string
  value: string
  inputMode?: 'numeric'
  placeholder?: string
  suffix?: string
  /** Returns an error message, or null when the text can be saved. */
  validate: (text: string) => string | null
  onSave: (text: string) => void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  // Follow changes made elsewhere (tray, Restore defaults) while not mid-edit.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
    setError(null)
  }

  const commit = (): void => {
    if (draft === value) return setError(null)
    const problem = validate(draft)
    setError(problem)
    if (!problem) onSave(draft)
  }

  return (
    <div className="setting-field">
      <label htmlFor={id}>{label}</label>
      <div className="setting-input">
        <input
          id={id}
          type="text"
          inputMode={inputMode}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape' && draft !== value) {
              e.preventDefault()
              setDraft(value)
              setError(null)
            }
          }}
        />
        {suffix && <span className="muted small">{suffix}</span>}
      </div>
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <p className="muted small" id={`${id}-hint`}>
        {hint}
      </p>
    </div>
  )
}

function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange
}: {
  legend: string
  name: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <fieldset className="setting-choice">
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map(([option, label]) => (
          <label key={option} className={value === option ? 'is-active' : ''}>
            <input
              type="radio"
              name={name}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function BrowserNote({
  settings,
  status
}: {
  settings: Settings
  status: BrowserStatus | null
}): React.JSX.Element {
  const chosen = settings.browser
  if (chosen === 'system') {
    return <p className="muted small">Links open in your macOS default browser.</p>
  }
  const name = BROWSER_LABELS[chosen]
  if (status?.lastFallback === chosen) {
    return (
      <p className="setting-warning small" role="note">
        {name} couldn&apos;t be opened last time, so that link opened in your default browser.
      </p>
    )
  }
  if (status && !status.installed[chosen]) {
    return (
      <p className="setting-warning small" role="note">
        {name} wasn&apos;t found in Applications. If it can&apos;t be opened, links open in your
        default browser instead.
      </p>
    )
  }
  return (
    <p className="muted small">
      Links open in {name}. Your macOS default browser isn&apos;t changed.
    </p>
  )
}

function RestoreDialog({
  settings,
  onConfirm,
  onClose
}: {
  settings: Settings
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const changes = diffSettings(settings)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="post-dialog"
      aria-labelledby="restore-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <header className="dialog-header">
        <h2 id="restore-title">Restore default settings?</h2>
      </header>
      <div className="dialog-body">
        <p>These settings will change:</p>
        <dl className="post-facts restore-changes">
          {changes.map((c) => (
            <div key={c.key} className="restore-change">
              <dt>{c.label}</dt>
              <dd>
                {c.from} <span aria-hidden="true">→</span>
                <span className="sr-only"> becomes </span> <strong>{c.to}</strong>
              </dd>
            </div>
          ))}
        </dl>
        <p className="muted small">History, saved reviews and window position are not touched.</p>
      </div>
      <footer className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          Restore defaults
        </button>
      </footer>
    </dialog>
  )
}

export function SettingsView({ onBack }: { onBack: () => void }): React.JSX.Element {
  const settings = useSettings()
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)
  const prefix = useId()

  useEffect(() => {
    let alive = true
    window.api
      .browserStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [settings?.browser])

  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const backRef = useRef(onBack)
  useEffect(() => {
    backRef.current = onBack
  })
  // Esc goes back, unless a dialog is open or a field used it to undo its edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !dialogOpen()) backRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const save = async (change: Partial<Settings>, note = 'Saved.'): Promise<void> => {
    try {
      await window.api.updateSettings(change)
      setMessage(note)
    } catch {
      setMessage("Couldn't save the setting.")
    }
  }

  const restore = async (): Promise<void> => {
    setConfirming(false)
    try {
      await window.api.restoreDefaultSettings()
      setMessage('Default settings restored.')
    } catch {
      setMessage("Couldn't restore the defaults.")
    }
  }

  const atDefaults = settings ? diffSettings(settings).length === 0 : true

  return (
    <div className="review-view settings-view">
      <header className="review-header">
        <button
          type="button"
          className="icon-button"
          onClick={onBack}
          aria-label="Back"
          title="Back (Esc)"
        >
          ←
        </button>
        <div className="review-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            Settings
          </h1>
          <span className="muted small">Changes apply right away</span>
        </div>
      </header>

      <div className="review-body">
        {!settings ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="settings">
            <p className="sr-only" role="status" aria-live="polite">
              {message}
            </p>

            <section className="setting-group" aria-labelledby={`${prefix}-links`}>
              <h2 className="section-title" id={`${prefix}-links`}>
                Links
              </h2>
              <Segmented
                legend="Open links in"
                name={`${prefix}-browser`}
                value={settings.browser}
                options={BROWSERS.map((b) => [b, BROWSER_LABELS[b]] as const)}
                onChange={(browser) => void save({ browser })}
              />
              <BrowserNote settings={settings} status={status} />
            </section>

            <section className="setting-group" aria-labelledby={`${prefix}-github`}>
              <h2 className="section-title" id={`${prefix}-github`}>
                GitHub
              </h2>
              <Segmented
                legend="Default review type"
                name={`${prefix}-mode`}
                value={settings.defaultPostMode}
                options={[
                  ['comment', 'Comment'],
                  ['request_changes', 'Request changes']
                ]}
                onChange={(defaultPostMode) => void save({ defaultPostMode })}
              />
              <p className="muted small">
                Preselected when you post. You still see and confirm the exact review first, and
                Request changes is never offered on your own PRs.
              </p>
            </section>

            <section className="setting-group" aria-labelledby={`${prefix}-reviews`}>
              <h2 className="section-title" id={`${prefix}-reviews`}>
                Reviews
              </h2>
              <DraftField
                label="Timeout"
                suffix="minutes"
                inputMode="numeric"
                value={String(settings.reviewTimeoutMinutes)}
                hint={`${TIMEOUT_MINUTES.min} to ${TIMEOUT_MINUTES.max} minutes. A running review keeps the timeout it started with.`}
                validate={(text) => {
                  const n = parseWhole(text, TIMEOUT_MINUTES)
                  return typeof n === 'string' ? n : null
                }}
                onSave={(text) => void save({ reviewTimeoutMinutes: Number(text.trim()) })}
              />
              <DraftField
                label="Model"
                placeholder="Claude Code default"
                value={settings.model}
                hint="Blank uses PR_HUB_MODEL if it's set, otherwise your Claude Code default. Applies to the next review."
                validate={(text) =>
                  text.trim() === '' || MODEL_PATTERN.test(text.trim())
                    ? null
                    : 'Use a model name such as sonnet, opus or claude-sonnet-5-5.'
                }
                onSave={(text) => void save({ model: text.trim() })}
              />
            </section>

            <section className="setting-group" aria-labelledby={`${prefix}-history`}>
              <h2 className="section-title" id={`${prefix}-history`}>
                History
              </h2>
              <DraftField
                label="Reviews kept"
                inputMode="numeric"
                value={String(settings.historyLimit)}
                hint={`${HISTORY_RETENTION.min} to ${HISTORY_RETENTION.max}. Pinned reviews are always kept and don't count. A lower number takes effect when the next review is saved.`}
                validate={(text) => {
                  const n = parseWhole(text, HISTORY_RETENTION)
                  return typeof n === 'string' ? n : null
                }}
                onSave={(text) => void save({ historyLimit: Number(text.trim()) })}
              />
            </section>

            <section className="setting-group" aria-labelledby={`${prefix}-window`}>
              <h2 className="section-title" id={`${prefix}-window`}>
                Window and notifications
              </h2>
              <label className="setting-check">
                <input
                  type="checkbox"
                  checked={settings.alwaysOnTop}
                  onChange={(e) => void save({ alwaysOnTop: e.target.checked })}
                />
                Keep the window on top
              </label>
              <label className="setting-check">
                <input
                  type="checkbox"
                  checked={settings.notifications}
                  onChange={(e) => void save({ notifications: e.target.checked })}
                />
                Notify me when a review finishes while the window is hidden
              </label>
            </section>

            <div className="settings-footer">
              <button
                type="button"
                className="secondary small-button"
                disabled={atDefaults}
                onClick={() => setConfirming(true)}
              >
                Restore defaults…
              </button>
              {atDefaults && <span className="muted small">Using the defaults</span>}
            </div>
          </div>
        )}
      </div>

      {confirming && settings && (
        <RestoreDialog
          settings={settings}
          onConfirm={() => void restore()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
