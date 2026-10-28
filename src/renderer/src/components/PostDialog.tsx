import { useCallback, useEffect, useRef, useState } from 'react'
import type { PostMode, PostPreview, PostRecord } from '@shared/github'
import type { Finding } from '@shared/findings'
import { prLabel } from '../review/format'
import { Markdown } from './Markdown'

interface Props {
  reviewId: string
  prUrl: string
  findings: Finding[]
  selectedIds: string[]
  defaultMode: PostMode
  onClose: () => void
  onPosted: (record: PostRecord) => void
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: PostPreview }
  | { kind: 'error'; message: string; needsAuth?: boolean }
  | { kind: 'posting'; preview: PostPreview }
  | { kind: 'posted'; record: PostRecord }

// Shows exactly what will be sent (built and cached by the main process) and posts only on
// an explicit click. Closing the dialog posts nothing.
export function PostDialog(props: Props): React.JSX.Element {
  const { reviewId, findings, selectedIds, onClose, onPosted } = props
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<PostMode>(props.defaultMode)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const titleOf = (id: string): string => findings.find((f) => f.id === id)?.title ?? id

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    let alive = true
    window.api
      .previewPost(reviewId, selectedIds, mode)
      .then((res) => {
        if (!alive) return
        setStatus(
          res.ok
            ? { kind: 'ready', preview: res.preview }
            : { kind: 'error', message: res.error, needsAuth: res.needsAuth }
        )
      })
      .catch((error: Error) => alive && setStatus({ kind: 'error', message: error.message }))
    return () => {
      alive = false
    }
  }, [reviewId, selectedIds, mode, attempt])

  const changeMode = (next: PostMode): void => {
    setStatus({ kind: 'loading' })
    setMode(next)
  }

  const retry = (): void => {
    setStatus({ kind: 'loading' })
    setAttempt((a) => a + 1)
  }

  const submit = useCallback(async () => {
    if (status.kind !== 'ready') return
    setStatus({ kind: 'posting', preview: status.preview })
    const res = await window.api.post(status.preview.previewId)
    if (res.ok) {
      setStatus({ kind: 'posted', record: res.record })
      onPosted(res.record)
    } else {
      setStatus({ kind: 'error', message: res.error })
    }
  }, [status, onPosted])

  const preview = status.kind === 'ready' || status.kind === 'posting' ? status.preview : null
  const busy = status.kind === 'loading' || status.kind === 'posting'

  return (
    <dialog
      ref={dialogRef}
      className="post-dialog"
      aria-labelledby="post-dialog-title"
      onCancel={(e) => {
        if (status.kind === 'posting') e.preventDefault()
        else onClose()
      }}
    >
      <header className="dialog-header">
        <h2 id="post-dialog-title">Post to GitHub</h2>
        <span className="muted small">{prLabel(props.prUrl)}</span>
      </header>

      <div className="dialog-body">
        {status.kind === 'posted' ? (
          <div className="post-success" role="status">
            <p>
              Review posted to <strong>{prLabel(props.prUrl)}</strong>.
            </p>
            <a href={status.record.url} target="_blank" rel="noreferrer">
              Open it on GitHub
            </a>
          </div>
        ) : (
          <>
            <fieldset className="mode-toggle" disabled={busy}>
              <legend className="sr-only">Review type</legend>
              {(
                [
                  ['comment', 'Comment'],
                  ['request_changes', 'Request changes']
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={mode === value ? 'is-active' : ''}>
                  <input
                    type="radio"
                    name="post-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => changeMode(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            {status.kind === 'loading' && (
              <p className="muted" aria-live="polite">
                <span className="spinner inline-spinner" aria-hidden="true" /> Checking GitHub and
                building the review…
              </p>
            )}

            {status.kind === 'error' && (
              <div className="dialog-error" role="alert">
                <p>{status.message}</p>
                {status.needsAuth && <pre className="command">gh auth login</pre>}
              </div>
            )}

            {preview && (
              <>
                <p className="muted small">
                  Posting as <strong>@{preview.account}</strong> · {preview.comments.length} inline
                  comment(s)
                  {preview.inBody.length > 0 && ` · ${preview.inBody.length} in the summary`}
                </p>
                {preview.warnings.map((w) => (
                  <p key={w} className="notice">
                    {w}
                  </p>
                ))}

                <h3 className="section-title">Review summary</h3>
                <div className="preview-box">
                  <Markdown>{preview.body}</Markdown>
                </div>
                {preview.inBody.length > 0 && (
                  <ul className="muted small reasons">
                    {preview.inBody.map((b) => (
                      <li key={b.findingId}>
                        “{titleOf(b.findingId)}” is in the summary because {b.reason}.
                      </li>
                    ))}
                  </ul>
                )}

                {preview.comments.length > 0 && (
                  <>
                    <h3 className="section-title">Inline comments</h3>
                    {preview.comments.map((c) => (
                      <div key={c.findingId} className="preview-box">
                        <code className="location">
                          {c.path}:{c.line}
                        </code>
                        {c.body.includes('```suggestion') && (
                          <span className="pill pill-info suggestion-pill">
                            One-click suggestion: replaces line {c.line}
                          </span>
                        )}
                        <Markdown>{c.body}</Markdown>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>

      <footer className="dialog-footer">
        {status.kind === 'posted' ? (
          <button type="button" className="primary" onClick={onClose} autoFocus>
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={status.kind === 'posting'}
            >
              Cancel
            </button>
            {status.kind === 'error' ? (
              <button type="button" className="primary" onClick={retry}>
                Try again
              </button>
            ) : (
              <button
                type="button"
                className={mode === 'request_changes' ? 'primary danger' : 'primary'}
                onClick={submit}
                disabled={status.kind !== 'ready'}
              >
                {status.kind === 'posting'
                  ? 'Posting…'
                  : mode === 'request_changes'
                    ? 'Post: request changes'
                    : 'Post review'}
              </button>
            )}
          </>
        )}
      </footer>
    </dialog>
  )
}
