import type { Lifecycle } from '@shared/incremental'
import type { Findings } from '@shared/findings'

export const VERDICTS: Record<Findings['verdict'], { label: string; tone: string }> = {
  approve: { label: 'Approve', tone: 'good' },
  approve_with_suggestions: { label: 'Approve with suggestions', tone: 'info' },
  request_changes: { label: 'Request changes', tone: 'bad' }
}

export const LIFECYCLE_TONE: Record<Lifecycle, string> = {
  new: 'info',
  still_present: 'warn',
  resolved: 'good',
  unable_to_verify: 'muted'
}
