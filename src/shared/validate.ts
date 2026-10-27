export interface PrRef {
  owner: string
  repo: string
  number: number
  /** Canonical https://github.com/<owner>/<repo>/pull/<n> form. */
  url: string
}

export interface ReviewInput {
  title: string
  prUrl: string
  description: string
}

export type ReviewInputErrors = Partial<Record<keyof ReviewInput, string>>

// Owner: GitHub user/org names (alphanumeric + hyphen). Repo: also allows . and _.
// Anything after the PR number (/files, /commits, ?query, #hash) is ignored.
const PR_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/

export function parsePrUrl(raw: string): PrRef | null {
  const match = PR_URL.exec(raw.trim())
  if (!match) return null
  const [, owner, repo, num] = match
  const number = Number(num)
  if (!Number.isSafeInteger(number) || number < 1) return null
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` }
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
