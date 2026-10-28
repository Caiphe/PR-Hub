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
}

export interface PostPreview {
  /** Pass to postReview() to submit exactly this payload. */
  previewId: string
  account: string
  mode: PostMode
  /** Review body markdown exactly as it will be posted. */
  body: string
  comments: InlineComment[]
  inBody: BodyFinding[]
  warnings: string[]
}

export interface PostRecord {
  at: number
  url: string
  mode: PostMode
  findingIds: string[]
}

export type PreviewResult =
  { ok: true; preview: PostPreview } | { ok: false; error: string; needsAuth?: boolean }

export type PostResult = { ok: true; record: PostRecord } | { ok: false; error: string }
