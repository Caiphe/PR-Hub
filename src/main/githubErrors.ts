import type { GitHubProblem, PostFailureKind, TokenKind } from '../shared/github'

// Turns raw gh CLI / GitHub API failures into specific, actionable guidance. Pure, so every
// message shape can be tested without GitHub. The original text is kept (shortened and with
// anything token-like removed) as `detail` for troubleshooting.

/** What was being attempted: reading needs less permission than posting a review. */
export type GhOperation = 'read' | 'post'

export interface FailureContext {
  operation: GhOperation
  /** The child process was killed by our timeout. */
  timedOut?: boolean
  tokenKind?: TokenKind
}

const TOKEN_PATTERNS: RegExp[] = [
  // Fine-grained PATs, then classic/OAuth/user-to-server/server-to-server/refresh tokens.
  /github_pat_[A-Za-z0-9_*]+/g,
  /\bgh[pousr]_[A-Za-z0-9*]+/g,
  // Header values and gh's "Token: …" status line, whatever the token looks like.
  /\b(authorization:\s*(?:token|bearer|basic)\s+)\S+/gi,
  /\b((?:token|bearer)\s+)[A-Za-z0-9_\-.=]{20,}/gi,
  /\b(token:\s*)\S+/gi
]

/** Removes anything that could be a credential. Commit SHAs are left alone. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'
    )
  }
  return out
}

/** A short, redacted copy of the raw error for the "Details" disclosure. */
export function conciseDetail(raw: string): string | undefined {
  const text = redactSecrets(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join('\n')
    .slice(0, 600)
  return text || undefined
}

/**
 * gh api prints "gh: <message> (HTTP nnn)" on stderr and the JSON error body on stdout.
 * Validation details (e.g. "line must be part of the diff") only appear in the body.
 */
export function describeGhOutput(stderr: string, stdout: string): string {
  const parts = [stderr.trim()]
  try {
    const body = JSON.parse(stdout) as {
      message?: unknown
      errors?: Array<string | { message?: unknown; field?: unknown; code?: unknown }>
    }
    if (typeof body.message === 'string' && !parts[0].includes(body.message)) {
      parts.push(body.message)
    }
    for (const e of body.errors ?? []) {
      if (typeof e === 'string') parts.push(e)
      else if (typeof e?.message === 'string') parts.push(e.message)
      else if (e?.field || e?.code) parts.push(`${String(e.field ?? '')} ${String(e.code ?? '')}`)
    }
  } catch {
    // Not JSON (or empty): stderr is all there is.
  }
  return parts.filter(Boolean).join('\n')
}

const LOGIN_COMMAND = 'gh auth login --hostname github.com --web'

const FINE_GRAINED_STEPS = [
  'On GitHub, open Settings → Developer settings → Fine-grained tokens and edit the token gh uses.',
  "Set Resource owner to the repository's owner (your account or the organization). A fine-grained token can only reach repositories that owner holds.",
  'Under Repository access, include the base repository of this PR (the one it merges into, not your fork).',
  'Under Repository permissions, set Pull requests to "Read and write".',
  'Or replace the token with a browser login, which works across repositories you can access.'
]

function problem(
  kind: GitHubProblem['kind'],
  title: string,
  message: string,
  actions: string[],
  command?: string
): Omit<GitHubProblem, 'detail'> {
  return command ? { kind, title, message, actions, command } : { kind, title, message, actions }
}

function classifyText(text: string, ctx: FailureContext): Omit<GitHubProblem, 'detail'> {
  const posting = ctx.operation === 'post'

  if (ctx.timedOut) {
    return posting
      ? problem(
          'timeout',
          'No answer from GitHub',
          'GitHub did not respond in time. The review may or may not have been posted.',
          [
            'Open the PR on GitHub and check its reviews before posting again, so you do not post the same review twice.'
          ]
        )
      : problem('timeout', 'GitHub did not respond in time', 'The request timed out.', [
          'Check your connection and https://githubstatus.com, then try again.'
        ])
  }

  if (
    /error connecting to|check your internet connection|dial tcp|no such host|could not resolve|connection refused|connection reset|network is unreachable|i\/o timeout|tls handshake|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(
      text
    )
  ) {
    return problem(
      'network',
      "Can't reach GitHub",
      posting
        ? 'The connection to GitHub failed before the review was sent.'
        : 'The connection to GitHub failed.',
      ['Check your internet connection, VPN or proxy, then try again.']
    )
  }

  if (/rate limit|HTTP 429|abuse detection/i.test(text)) {
    return problem(
      'rate_limited',
      'GitHub rate limit reached',
      'GitHub is temporarily refusing requests from this account.',
      [
        'Wait a few minutes (secondary limits) or up to an hour (primary limit), then try again.',
        'Run the command below to see when the limit resets.'
      ],
      'gh api rate_limit --jq .resources.core'
    )
  }

  if (/SAML|single sign-on|\bSSO\b/i.test(text)) {
    return problem(
      'sso_required',
      'Organization requires SSO authorization',
      "This organization uses SAML single sign-on, and gh's credential hasn't been authorized for it.",
      [
        'For a personal access token: open it on GitHub, choose "Configure SSO", and authorize the organization.',
        'For a browser login: run the command below and complete the SSO step for the organization.'
      ],
      LOGIN_COMMAND
    )
  }

  if (
    /OAuth App access restrictions|forbids access via (?:a )?fine-grained|fine-grained personal access tokens? (?:is|are) not allowed|pending (?:owner )?approval|has not been approved|requires approval/i.test(
      text
    )
  ) {
    return problem(
      'org_approval',
      'Organization approval needed',
      "The organization that owns this repository restricts third-party access, and gh's credential hasn't been approved.",
      [
        'Ask an organization owner to approve the request (fine-grained tokens) or the GitHub CLI app (browser logins).',
        'Organization owners can do this under Settings → Third-party access or Personal access tokens → Pending requests.'
      ]
    )
  }

  if (/request changes on your own pull request/i.test(text)) {
    return problem(
      'own_pr_request_changes',
      "Can't request changes on your own PR",
      'GitHub only lets you comment on pull requests you opened.',
      ['Post as Comment instead.']
    )
  }

  if (
    /must be part of the diff|could not be resolved|is not part of the pull request|position is invalid|no commit found for (?:the )?sha|pull_request_review_thread\.(?:line|path|position)/i.test(
      text
    )
  ) {
    return problem(
      'stale_position',
      'Inline comment positions are out of date',
      "GitHub rejected an inline comment because its line isn't in the PR's current diff. The PR probably changed since the preview was built.",
      [
        'Click Try again to rebuild the preview from the current PR.',
        'If the PR has new commits, re-run the review for inline comments on the right lines.'
      ]
    )
  }

  if (/Resource not accessible by personal access token/i.test(text)) {
    return posting
      ? problem(
          'pull_requests_permission',
          "Token can't post to this repository",
          'gh is using a fine-grained personal access token that can read this PR but is not allowed to create reviews on it.',
          FINE_GRAINED_STEPS,
          LOGIN_COMMAND
        )
      : problem(
          'fine_grained_repo_access',
          "Token doesn't include this repository",
          "gh is using a fine-grained personal access token that hasn't been given access to this PR's repository.",
          FINE_GRAINED_STEPS,
          LOGIN_COMMAND
        )
  }

  if (
    /Resource not accessible by integration|must have (?:admin|push|write)|HTTP 403|forbidden/i.test(
      text
    )
  ) {
    return problem(
      'permission',
      posting ? 'GitHub refused the post' : 'GitHub refused access',
      posting
        ? "gh's credential doesn't have permission to review this pull request."
        : "gh's credential doesn't have permission to read this pull request.",
      [
        'Check that your account can access the repository in a browser.',
        'If gh uses a token (GH_TOKEN, a PAT or an app token), give it access to the repository with Pull requests: Read and write, or sign in with the browser instead.'
      ],
      LOGIN_COMMAND
    )
  }

  if (
    /HTTP 401|bad credentials|token (?:in \S+ )?is (?:invalid|expired)|failed to log in|authentication failed|requires authentication/i.test(
      text
    )
  ) {
    return problem(
      'invalid_login',
      'GitHub login is invalid or expired',
      "gh is signed in, but GitHub no longer accepts its credential (it was revoked, expired, or the token's lifetime ended).",
      [
        'Run the command below to sign in again.',
        'If GH_TOKEN or GITHUB_TOKEN is set in your shell, update or remove it: gh uses it before its own login.'
      ],
      LOGIN_COMMAND
    )
  }

  if (
    /not logged in|no (?:github )?hosts|gh auth login|To get started with GitHub CLI/i.test(text)
  ) {
    return problem(
      'signed_out',
      'GitHub CLI is not signed in',
      'gh has no GitHub account. Public PRs can still be reviewed; private PRs and posting need a login.',
      ['Run the command below in a terminal and follow the prompts, then check again.'],
      LOGIN_COMMAND
    )
  }

  if (/HTTP 404|not found/i.test(text)) {
    return problem(
      'not_found',
      'PR not found',
      ctx.tokenKind === 'fine_grained_pat'
        ? "GitHub says this PR doesn't exist. For a private repository, that usually means the fine-grained token doesn't include it."
        : "GitHub says this PR doesn't exist, or your account can't see the repository.",
      [
        'Check the PR link.',
        'For a private repository, make sure the signed-in account (or token) has access to it.'
      ]
    )
  }

  if (/HTTP 422|unprocessable|validation failed/i.test(text)) {
    return problem(
      'validation',
      'GitHub rejected the review',
      'GitHub said the request was invalid. The details below give its reason.',
      ['Click Try again to rebuild the preview. If it keeps failing, re-run the review.']
    )
  }

  if (/HTTP 5\d\d|server error|bad gateway|service unavailable/i.test(text)) {
    return problem(
      'server_error',
      'GitHub is having trouble',
      posting
        ? 'GitHub returned a server error. The review may not have been posted.'
        : 'GitHub returned a server error.',
      [
        posting
          ? 'Check the PR on GitHub before posting again, then retry in a few minutes.'
          : 'Check https://githubstatus.com and try again in a few minutes.'
      ]
    )
  }

  return problem(
    'unknown',
    'GitHub request failed',
    'gh reported an error PR Hub does not recognize.',
    ['See the details below. Running the same action again after checking your login often helps.']
  )
}

/** Guidance for a login problem found by `gh auth status`, which has no API error to classify. */
export function loginProblem(state: 'signed_out' | 'invalid'): GitHubProblem {
  return classifyText(state === 'signed_out' ? 'not logged in' : 'HTTP 401', { operation: 'read' })
}

export { FINE_GRAINED_STEPS, LOGIN_COMMAND }

export function classifyGhFailure(raw: string, ctx: FailureContext): GitHubProblem {
  const base = classifyText(raw, ctx)
  const detail = conciseDetail(raw)
  return detail ? { ...base, detail } : base
}

/**
 * What a failed post means for retrying. Decides whether the same exact preview can be sent
 * again, and whether GitHub might already have the review.
 * - retryable: GitHub refused before accepting anything (rate limit, couldn't connect).
 * - needs_auth: a login or permission must be fixed first; nothing was accepted.
 * - needs_new_preview: GitHub rejected the content (the PR changed, own-PR rules).
 * - ambiguous: the request may have reached GitHub (timeout, dropped connection, 5xx,
 *   anything unrecognized). Check before posting again.
 */
export function postFailureKind(problem: GitHubProblem, raw: string): PostFailureKind {
  switch (problem.kind) {
    case 'rate_limited':
      return 'retryable'
    case 'network':
      // A connection that was never made can't have delivered anything. One that dropped
      // mid-request might have.
      return /connection reset|broken pipe|unexpected EOF|\bEOF\b|stream error|i\/o timeout/i.test(
        raw
      )
        ? 'ambiguous'
        : 'retryable'
    case 'cli_missing':
    case 'signed_out':
    case 'invalid_login':
    case 'sso_required':
    case 'org_approval':
    case 'permission':
    case 'pull_requests_permission':
    case 'fine_grained_repo_access':
    case 'not_found':
      return 'needs_auth'
    case 'own_pr_request_changes':
    case 'stale_position':
    case 'validation':
      return 'needs_new_preview'
    case 'timeout':
    case 'server_error':
    case 'unknown':
      return 'ambiguous'
  }
}

export function needsAuthFix(problem: GitHubProblem): boolean {
  return ['signed_out', 'invalid_login', 'sso_required'].includes(problem.kind)
}

export const CLI_MISSING: GitHubProblem = {
  kind: 'cli_missing',
  title: 'GitHub CLI not installed',
  message:
    'PR Hub uses the GitHub CLI (gh) for private repositories and posting. Public PRs can be reviewed without it.',
  actions: ['Install it from https://cli.github.com (or `brew install gh`), then sign in.'],
  command: 'brew install gh && gh auth login --hostname github.com --web'
}
