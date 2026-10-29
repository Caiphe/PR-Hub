import { parsePrUrl } from '@shared/validate'
import {
  accountLine,
  POSTING_LABELS,
  POSTING_TONES,
  repoFor,
  repoLine,
  statusChip
} from '../review/githubStatus'
import type { GitHubStatusState } from '../review/useGitHubStatus'
import { prLabel } from '../review/format'
import { GitHubProblemNotice } from './GitHubProblemNotice'

export function GitHubStatusChip({ state }: { state: GitHubStatusState }): React.JSX.Element {
  const chip = statusChip(state.view)
  return (
    <button
      type="button"
      className={`gh-chip gh-chip-${chip.tone}`}
      aria-expanded={state.open}
      aria-controls={state.panelId}
      title="GitHub connection details"
      onClick={state.toggle}
    >
      {state.view.kind === 'checking' ? (
        <span className="spinner gh-chip-spinner" aria-hidden="true" />
      ) : (
        <span className="gh-chip-dot" aria-hidden="true" />
      )}
      <span aria-live="polite">{chip.label}</span>
      <span className="gh-chip-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  )
}

export function GitHubStatusPanel({
  state,
  prUrl
}: {
  state: GitHubStatusState
  prUrl: string
}): React.JSX.Element | null {
  if (!state.open) return null
  const { view } = state
  const status = view.kind === 'ready' ? view.status : null
  const ref = parsePrUrl(prUrl)
  const repo = repoFor(status, prUrl)
  const checking = view.kind === 'checking'

  return (
    <section id={state.panelId} className="gh-panel" aria-label="GitHub connection">
      {view.kind === 'failed' && (
        <p className="gh-panel-error" role="alert">
          {view.message}
        </p>
      )}
      {status && (
        <>
          <dl className="gh-facts">
            <dt>GitHub CLI</dt>
            <dd>
              {status.cli.installed
                ? `Installed${status.cli.version ? ` (${status.cli.version})` : ''}`
                : 'Not installed'}
            </dd>
            <dt>Account</dt>
            <dd>{status.cli.installed ? accountLine(status.auth) : '—'}</dd>
            {ref && (
              <>
                <dt>This PR</dt>
                <dd>{repoLine(repo)}</dd>
              </>
            )}
            <dt>Posting</dt>
            <dd>
              <span className={`pill pill-${POSTING_TONES[status.posting.state]}`}>
                {POSTING_LABELS[status.posting.state]}
              </span>
            </dd>
          </dl>
          <p className="gh-panel-note">{status.posting.message}</p>

          {status.problems.map((problem, i) => (
            <GitHubProblemNotice key={`${problem.kind}-${i}`} problem={problem} />
          ))}
          {status.problems.length === 0 && status.posting.actions && (
            <details className="gh-panel-howto">
              <summary>How to make sure posting works</summary>
              <ol className="gh-problem-steps">
                {status.posting.actions.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {status.posting.command && <pre className="command">{status.posting.command}</pre>}
            </details>
          )}
        </>
      )}

      <div className="gh-panel-actions">
        {ref && (
          <button
            type="button"
            className="secondary small-button"
            disabled={checking}
            onClick={() => state.check(ref.url)}
          >
            Check access to {prLabel(ref.url)}
          </button>
        )}
        <button
          type="button"
          className="link-button"
          disabled={checking}
          onClick={() => state.check(repo ? ref?.url : undefined)}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <p className="gh-panel-foot">
        Read-only check: nothing is posted. Public PRs can be reviewed without signing in.
      </p>
    </section>
  )
}
