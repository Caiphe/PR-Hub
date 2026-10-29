import type { PostResult } from '@shared/github'

// What the post dialog offers after a failed post. Kept pure so the rules that prevent
// duplicate reviews are tested: after an unclear outcome, sending again is always a separate,
// explicitly labeled choice, and changing the review is locked until it's resolved.

export type PostFailure = Extract<PostResult, { ok: false }>

export type PostAction =
  /** Send the same preview again (nothing reached GitHub). */
  | 'retry'
  /** Build a new preview from the current PR. */
  | 'rebuild'
  /** Look for the submission on GitHub without posting. */
  | 'check'
  /** Send again after checking found nothing. */
  | 'post_again'
  /** Send even though the check itself failed. */
  | 'post_anyway'
  | 'switch_to_comment'

export interface FailureView {
  title: string
  primary: PostAction | null
  secondary: PostAction[]
  /** Mode and selection stay fixed: the earlier submission may be on GitHub. */
  locked: boolean
}

export function failureView(failure: PostFailure): FailureView {
  switch (failure.failure) {
    case 'retryable':
      return { title: 'Nothing was posted', primary: 'retry', secondary: [], locked: false }
    case 'needs_auth':
      return {
        title: 'Nothing was posted: fix access, then try again',
        primary: 'retry',
        secondary: ['rebuild'],
        locked: false
      }
    case 'needs_new_preview':
      return {
        title: 'Nothing was posted: the preview needs rebuilding',
        primary:
          failure.problem?.kind === 'own_pr_request_changes' ? 'switch_to_comment' : 'rebuild',
        secondary: [],
        locked: false
      }
    case 'busy':
      return { title: 'Already posting', primary: null, secondary: [], locked: true }
    case 'ambiguous':
      return failure.checked === 'not_found'
        ? {
            title: 'Not confirmed: probably not posted',
            primary: 'check',
            secondary: ['post_again'],
            locked: true
          }
        : {
            title: "Not confirmed: couldn't check GitHub",
            primary: 'check',
            secondary: ['post_anyway'],
            locked: true
          }
  }
}

export const ACTION_LABELS: Record<PostAction, string> = {
  retry: 'Try again',
  rebuild: 'Rebuild preview',
  check: 'Check GitHub again',
  post_again: 'Post again',
  post_anyway: 'Post anyway',
  switch_to_comment: 'Switch to Comment'
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'unknown'
}
