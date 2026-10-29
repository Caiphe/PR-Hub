import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHubProblem, PostMode, PostPreview, PostRecord } from '@shared/github'
import { withoutSubmissionMarker } from '@shared/github'
import type { Finding } from '@shared/findings'
import { prLabel } from '../review/format'
import {
  ACTION_LABELS,
  failureView,
  shortSha,
  type PostAction,
  type PostFailure
} from '../review/postFlow'
import { GitHubProblemNotice } from './GitHubProblemNotice'
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
  | { kind: 'previewError'; message: string; needsAuth?: boolean; problem?: GitHubProblem }
  | { kind: 'ready'; preview: PostPreview }
  | { kind: 'posting'; preview: PostPreview; checking: boolean }
  /** The preview stays on screen so the user can fix the cause and retry the same review. */
  | { kind: 'failed'; preview: PostPreview; result: PostFailure }
  | { kind: 'posted'; record: PostRecord; recovered: boolean }

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
            : {
                kind: 'previewError',
                message: res.error,
                needsAuth: res.needsAuth,
                problem: res.problem
              }
        )
      })
      .catch((error: Error) => alive && setStatus({ kind: 'previewError', message: error.message }))
    return () => {
      alive = false
    }
  }, [reviewId, selectedIds, mode, attempt])

  const changeMode = (next: PostMode): void => {
    setStatus({ kind: 'loading' })
    setMode(next)
  }

  const rebuild = (): void => {
    setStatus({ kind: 'loading' })
    setAttempt((a) => a + 1)
  }

  /** Posts (or, with `check`, only looks for) the preview that's on screen. */
  const send = useCallback(
    async (preview: PostPreview, how: 'post' | 'force' | 'check') => {
      setStatus({ kind: 'posting', preview, checking: how === 'check' })
      const res =
        how === 'check'
          ? await window.api.verifyPost(preview.previewId)
          : await window.api.post(preview.previewId, { force: how === 'force' })
      if (res.ok) {
        setStatus({ kind: 'posted', record: res.record, recovered: res.recovered === true })
        onPosted(res.record)
      } else {
        setStatus({ kind: 'failed', preview, result: res })
      }
    },
    [onPosted]
  )

  const preview =
    status.kind === 'ready' || status.kind === 'posting' || status.kind === 'failed'
      ? status.preview
      : null
  const failure = status.kind === 'failed' ? failureView(status.result) : null
  // After an unclear outcome the review can't be changed: the earlier one may be on GitHub.
  const locked = status.kind === 'posting' || (failure?.locked ?? false)
  const blockedOwnPr = !!preview?.ownPr && mode === 'request_changes'
  const moved = preview?.inBody.filter((b) => b.movedByChange) ?? []
  const otherInBody = preview?.inBody.filter((b) => !b.movedByChange) ?? []

  const run = (action: PostAction): void => {
    if (!preview && action !== 'rebuild') return
    if (action === 'rebuild') rebuild()
    else if (action === 'switch_to_comment') changeMode('comment')
    else if (action === 'check') void send(preview!, 'check')
    else if (action === 'post_anyway') void send(preview!, 'force')
    else void send(preview!, 'post')
  }

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
            {status.recovered ? (
              <p>
                GitHub didn&apos;t confirm the post at first, but PR Hub found it on{' '}
                <strong>{prLabel(props.prUrl)}</strong>. It was posted once and is recorded once.
              </p>
            ) : (
              <p>
                Review posted to <strong>{prLabel(props.prUrl)}</strong>.
              </p>
            )}
            <a href={status.record.url} target="_blank" rel="noreferrer">
              Open it on GitHub
            </a>
          </div>
        ) : (
          <>
            <fieldset className="mode-toggle" disabled={locked || status.kind === 'loading'}>
              <legend className="sr-only">Review type</legend>
              {(
                [
                  ['comment', 'Comment'],
                  ['request_changes', 'Request changes']
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={`${mode === value ? 'is-active' : ''} ${
                    value === 'request_changes' && preview?.ownPr ? 'is-disabled' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="post-mode"
                    value={value}
                    checked={mode === value}
                    disabled={value === 'request_changes' && !!preview?.ownPr && mode !== value}
                    onChange={() => changeMode(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {preview?.ownPr && (
              <div className={blockedOwnPr ? 'notice own-pr-notice' : 'muted small'}>
                <p>
                  You opened this PR, so GitHub only accepts comments from you, not Request changes.
                </p>
                {blockedOwnPr && (
                  <button
                    type="button"
                    className="secondary small-button"
                    onClick={() => changeMode('comment')}
                  >
                    Switch to Comment
                  </button>
                )}
              </div>
            )}

            {status.kind === 'loading' && (
              <p className="muted" aria-live="polite">
                <span className="spinner inline-spinner" aria-hidden="true" /> Checking GitHub and
                building the review…
              </p>
            )}

            {status.kind === 'previewError' &&
              (status.problem ? (
                <div className="dialog-error">
                  <GitHubProblemNotice problem={status.problem} role="alert" />
                </div>
              ) : (
                <div className="dialog-error" role="alert">
                  <p>{status.message}</p>
                  {status.needsAuth && <pre className="command">gh auth login</pre>}
                </div>
              ))}

            {status.kind === 'posting' && (
              <p className="muted" aria-live="polite">
                <span className="spinner inline-spinner" aria-hidden="true" />{' '}
                {status.checking ? 'Looking for this review on GitHub…' : 'Posting…'}
              </p>
            )}

            {status.kind === 'failed' && failure && (
              <div
                className={`post-failure ${status.result.failure === 'ambiguous' ? 'is-unclear' : ''}`}
                role="alert"
              >
                <p className="post-failure-title">{failure.title}</p>
                {status.result.failure === 'ambiguous' ? (
                  <>
                    <p>{status.result.error}</p>
                    <p>
                      PR Hub won&apos;t send it again by itself.{' '}
                      <a href={props.prUrl} target="_blank" rel="noreferrer">
                        Open the PR on GitHub
                      </a>{' '}
                      to look, or check again.
                    </p>
                  </>
                ) : status.result.problem ? (
                  <GitHubProblemNotice problem={status.result.problem} />
                ) : (
                  <p>{status.result.error}</p>
                )}
                {failure.secondary.length > 0 && (
                  <div className="row">
                    {failure.secondary.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className={`secondary small-button ${action === 'post_anyway' ? 'danger-text' : ''}`}
                        onClick={() => run(action)}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {preview && (
              <>
                <dl className="post-facts">
                  <dt>Account</dt>
                  <dd>@{preview.account}</dd>
                  <dt>Repository</dt>
                  <dd>{preview.repo}</dd>
                  <dt>Commit</dt>
                  <dd>
                    <code>{shortSha(preview.postingSha)}</code>
                    {preview.reviewedSha !== preview.postingSha && (
                      <span className="muted">
                        {' '}
                        (reviewed <code>{shortSha(preview.reviewedSha)}</code>)
                      </span>
                    )}
                  </dd>
                  <dt>Posting</dt>
                  <dd>
                    {mode === 'request_changes' ? 'Request changes' : 'Comment'} ·{' '}
                    {preview.comments.length} inline · {preview.inBody.length} in the summary
                  </dd>
                </dl>
                {preview.warnings.map((w) => (
                  <p key={w} className="notice">
                    {w}
                  </p>
                ))}

                {moved.length > 0 && (
                  <>
                    <h3 className="section-title">Moved to the summary because the PR changed</h3>
                    <ul className="small reasons moved-list">
                      {moved.map((b) => (
                        <li key={b.findingId}>
                          <strong>{titleOf(b.findingId)}</strong>: {b.reason}.
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <h3 className="section-title">Review summary</h3>
                <div className="preview-box">
                  <Markdown>{withoutSubmissionMarker(preview.body)}</Markdown>
                </div>
                <p className="muted small">
                  The summary ends with an invisible marker holding only a random id, so PR Hub can
                  find this review again if GitHub doesn&apos;t confirm the post.
                </p>
                {otherInBody.length > 0 && (
                  <ul className="muted small reasons">
                    {otherInBody.map((b) => (
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
              {failure?.locked ? 'Close' : 'Cancel'}
            </button>
            {status.kind === 'previewError' ? (
              <button type="button" className="primary" onClick={rebuild}>
                Try again
              </button>
            ) : failure ? (
              failure.primary && (
                <button type="button" className="primary" onClick={() => run(failure.primary!)}>
                  {ACTION_LABELS[failure.primary]}
                </button>
              )
            ) : (
              <button
                type="button"
                className={mode === 'request_changes' ? 'primary danger' : 'primary'}
                onClick={() => preview && void send(preview, 'post')}
                disabled={status.kind !== 'ready' || blockedOwnPr}
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
