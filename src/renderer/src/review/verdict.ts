import type { Findings } from '@shared/findings'

export const VERDICTS: Record<Findings['verdict'], { label: string; tone: string }> = {
  approve: { label: 'Approve', tone: 'good' },
  approve_with_suggestions: { label: 'Approve with suggestions', tone: 'info' },
  request_changes: { label: 'Request changes', tone: 'bad' }
}
