// Types for posting findings to GitHub as one pull request review. See PLAN.md phase 6.

export type PostMode = 'comment' | 'request_changes'

export interface InlineComment {
  findingId: string
  path: string
  line: number
  /** Markdown exactly as it will be posted. */
  body: string
}

export interface BodyFinding {
  findingId: string
  /** Why this finding goes in the review body rather than inline. */
  reason: string
  /** True when it would have been inline, but the PR changed since the review. */
  movedByChange?: boolean
}

export interface PostPreview {
  /** Pass to postReview() to submit exactly this payload. */
  previewId: string
  account: string
  /** Base repository, "owner/repo". */
  repo: string
  mode: PostMode
  /** The commit the review read, if recorded. */
  reviewedSha: string | null
  /** The PR head the comments are anchored to (the current head when the preview was built). */
  postingSha: string
  /** The signed-in account opened this PR, so GitHub won't accept Request changes. */
  ownPr: boolean
  /**
   * Review body markdown exactly as it will be posted. It ends with an invisible marker
   * (see submissionMarker) that lets PR Hub find this review again after an unclear outcome.
   */
  body: string
  submissionId: string
  comments: InlineComment[]
  inBody: BodyFinding[]
  warnings: string[]
}

export interface PostRecord {
  at: number
  url: string
  mode: PostMode
  findingIds: string[]
  /** Identifies one confirmed submission; absent on records saved before it existed. */
  submissionId?: string
}

/**
 * Invisible HTML comment appended to every review PR Hub posts. It holds only a random id that
 * PR Hub generated, never text from the review or the PR, so it can't hide content.
 */
export function submissionMarker(submissionId: string): string {
  return `<!-- pr-hub-submission:${submissionId} -->`
}

/** The body without the marker, for showing to people. */
export function withoutSubmissionMarker(body: string): string {
  return body.replace(/\n*<!-- pr-hub-submission:[0-9a-f-]{36} -->\s*$/, '')
}

/**
 * Why a post failed, for deciding what can safely happen next. See postFailureKind().
 * busy: this preview is already being posted.
 */
export type PostFailureKind =
  'retryable' | 'needs_auth' | 'needs_new_preview' | 'ambiguous' | 'busy'

/** A GitHub CLI/API failure translated into something a person can act on. */
export type GitHubProblemKind =
  | 'cli_missing'
  | 'signed_out'
  | 'invalid_login'
  | 'fine_grained_repo_access'
  | 'pull_requests_permission'
  | 'permission'
  | 'org_approval'
  | 'sso_required'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'own_pr_request_changes'
  | 'stale_position'
  | 'validation'
  | 'server_error'
  | 'unknown'

export interface GitHubProblem {
  kind: GitHubProblemKind
  /** Short headline, e.g. "Token can't post to this repository". */
  title: string
  message: string
  /** Steps that fix it, in order. */
  actions: string[]
  /** A terminal command that helps, if there is one. */
  command?: string
  /** The original error, shortened and with anything token-like removed. */
  detail?: string
}

export type TokenKind = 'oauth' | 'classic_pat' | 'fine_grained_pat' | 'app' | 'unknown'

/**
 * Read-only diagnosis of the gh login and, optionally, one PR. Never includes a token.
 * Posting permission can't be proven without posting, so `posting` is an estimate.
 */
export interface ConnectionStatus {
  checkedAt: number
  cli: { installed: boolean; version?: string }
  auth: {
    state: 'signed_in' | 'signed_out' | 'invalid' | 'unknown'
    login?: string
    tokenKind?: TokenKind
    /** Classic/OAuth token scopes; absent for fine-grained tokens, which have none. */
    scopes?: string[]
    /** Where gh got the credential: its keyring/config, or an environment variable. */
    source?: 'keyring' | 'config' | 'GH_TOKEN' | 'GITHUB_TOKEN'
  }
  /** Present only when a PR was checked. */
  repo?: {
    prUrl: string
    state: 'readable' | 'not_readable' | 'skipped'
    private?: boolean
    author?: string
    isOwnPr?: boolean
  }
  posting: {
    state: 'likely' | 'unverified' | 'unlikely' | 'unavailable'
    message: string
    /** What to check or change so posting works. */
    actions?: string[]
    command?: string
  }
  problems: GitHubProblem[]
}

export type PreviewResult =
  | { ok: true; preview: PostPreview }
  | { ok: false; error: string; needsAuth?: boolean; problem?: GitHubProblem }

export type PostResult =
  | {
      ok: true
      record: PostRecord
      /** The review was found on GitHub after an unclear outcome, rather than posted now. */
      recovered?: boolean
    }
  | {
      ok: false
      error: string
      problem?: GitHubProblem
      failure: PostFailureKind
      /**
       * For ambiguous failures: what PR Hub found when it looked for this submission on GitHub.
       * not_found: no review carries its marker. lookup_failed: the check itself failed.
       */
      checked?: 'not_found' | 'lookup_failed'
    }

/** An issue the PR body points at: "Fixes #12" (closes) or a plain issue link (mentions). */
export interface LinkedIssue {
  owner: string
  repo: string
  number: number
  url: string
  relation: 'closes' | 'mentions'
}

/**
 * Read-only PR metadata for the intake form. Title, body and branch names are written by the
 * PR author: untrusted text, shown as plain text and never followed as instructions.
 */
export interface PrMetadata {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  body: string
  /** The body was longer than a task description may be and was cut. */
  bodyTruncated: boolean
  author: string | null
  draft: boolean
  state: 'open' | 'closed' | 'merged'
  baseRef: string
  /** "branch", or "owner:branch" when the PR comes from a fork. */
  headLabel: string
  headSha: string
  changedFiles: number | null
  additions: number | null
  deletions: number | null
  linkedIssues: LinkedIssue[]
  /** gh (the user's login) or GitHub's public API (no login, public repositories only). */
  via: 'gh' | 'public_api'
}

export interface IssueDetails {
  url: string
  number: number
  title: string
  body: string
  bodyTruncated: boolean
  state: 'open' | 'closed'
}

export type InspectPrResult =
  { ok: true; pr: PrMetadata } | { ok: false; error: string; problem?: GitHubProblem }

export type InspectIssueResult =
  { ok: true; issue: IssueDetails } | { ok: false; error: string; problem?: GitHubProblem }
