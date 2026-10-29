export interface PrRef {
  owner: string
  repo: string
  number: number
  /** Canonical https://github.com/<owner>/<repo>/pull/<n> form. */
  url: string
}

/** Where the task text came from. PR and issue text is written by others, so it's untrusted. */
export const TASK_SOURCES = ['manual', 'pr', 'issue'] as const
export type TaskSource = (typeof TASK_SOURCES)[number]

export interface ReviewInput {
  title: string
  prUrl: string
  description: string
  /** Absent on reviews saved before task sources existed; treated as 'manual'. */
  taskSource?: TaskSource
}

export interface IssueRef {
  owner: string
  repo: string
  number: number
  /** Canonical https://github.com/<owner>/<repo>/issues/<n> form. */
  url: string
}

export type ReviewInputErrors = Partial<Record<keyof ReviewInput, string>>

// Owner: GitHub user/org names (alphanumeric + hyphen, at most 39). Repo: also allows . and _.
// Anything after the number (/files, /commits, ?query, #hash) is ignored.
export const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
export const REPO = '[A-Za-z0-9._-]{1,100}'
const PR_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/pull/(\\d+)(?:[/?#].*)?$`
)
const ISSUE_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/issues/(\\d+)(?:[/?#].*)?$`
)

/** Owner/repo/number checks shared by PR and issue links. "." and ".." would escape API paths. */
export function validRef(owner: string, repo: string, num: string): number | null {
  if (repo === '.' || repo === '..') return null
  const number = Number(num)
  if (!Number.isSafeInteger(number) || number < 1) return null
  return owner && repo ? number : null
}

export function parsePrUrl(raw: string): PrRef | null {
  const match = PR_URL.exec(raw.trim())
  if (!match) return null
  const [, owner, repo, num] = match
  const number = validRef(owner, repo, num)
  if (number === null) return null
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` }
}

export function parseIssueUrl(raw: string): IssueRef | null {
  const match = ISSUE_URL.exec(raw.trim())
  if (!match) return null
  const [, owner, repo, num] = match
  const number = validRef(owner, repo, num)
  if (number === null) return null
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` }
}

export const LIMITS = { title: 200, description: 20_000 }

export function validateReviewInput(input: ReviewInput): ReviewInputErrors {
  const errors: ReviewInputErrors = {}
  const title = input.title.trim()
  const description = input.description.trim()

  if (!title) errors.title = 'Add a task title.'
  else if (title.length > LIMITS.title) errors.title = `Keep it under ${LIMITS.title} characters.`

  if (!input.prUrl.trim()) errors.prUrl = 'Paste the PR link.'
  else if (!parsePrUrl(input.prUrl))
    errors.prUrl = 'Use a GitHub PR link like https://github.com/owner/repo/pull/123'

  if (!description) errors.description = 'Describe what the PR should accomplish.'
  else if (description.length > LIMITS.description)
    errors.description = `Keep it under ${LIMITS.description.toLocaleString('en-US')} characters.`

  return errors
}
