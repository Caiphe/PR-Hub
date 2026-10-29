import type { GitHubProblem } from '@shared/github'

// One GitHub failure explained: what happened, how to fix it, and the original error.
export function GitHubProblemNotice({
  problem,
  role
}: {
  problem: GitHubProblem
  role?: 'alert'
}): React.JSX.Element {
  return (
    <div className="gh-problem" role={role}>
      <p className="gh-problem-title">{problem.title}</p>
      <p>{problem.message}</p>
      {problem.actions.length > 0 && (
        <ol className="gh-problem-steps">
          {problem.actions.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {problem.command && <pre className="command">{problem.command}</pre>}
      {problem.detail && (
        <details className="gh-problem-detail">
          <summary>Error details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
    </div>
  )
}
