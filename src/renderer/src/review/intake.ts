import type { IssueDetails, PrMetadata } from '@shared/github'
import { LIMITS, parsePrUrl, type TaskSource } from '@shared/validate'

// Pure logic for URL-first intake: which PR the form is about, filling the task from PR or
// issue text without ever silently overwriting what the user wrote, and the PR summary.

export interface TaskText {
  title: string
  description: string
}
export type TaskField = keyof TaskText

/** The values PR Hub last put in each field. A field that still holds it was never edited. */
export type AutoFilled = Partial<TaskText>

/** Canonical link of the PR the form currently points at, or null. */
export function currentPrKey(rawUrl: string): string | null {
  return parsePrUrl(rawUrl)?.url ?? null
}

/** A response is only used if it's for the link the form shows now (older replies are dropped). */
export function isCurrent(responseUrl: string, rawUrl: string): boolean {
  return currentPrKey(rawUrl) === responseUrl
}

/** Text the user typed or changed. Empty fields and untouched auto-filled text are fair game. */
export function isUserEdited(value: string, autoValue: string | undefined): boolean {
  return value.trim() !== '' && value !== autoValue
}

export interface FillPlan {
  /** The form's text after filling every field that can be filled safely. */
  next: TaskText
  /** What PR Hub filled in (for isUserEdited later). */
  auto: AutoFilled
  /** Edited fields that would change: these need the user's confirmation. */
  conflicts: TaskField[]
}

export function planFill(current: TaskText, auto: AutoFilled, incoming: TaskText): FillPlan {
  const next = { ...current }
  const filled: AutoFilled = { ...auto }
  const conflicts: TaskField[] = []
  for (const field of ['title', 'description'] as const) {
    if (current[field] === incoming[field]) {
      filled[field] = incoming[field]
    } else if (isUserEdited(current[field], auto[field])) {
      conflicts.push(field)
    } else {
      next[field] = incoming[field]
      filled[field] = incoming[field]
    }
  }
  return { next, auto: filled, conflicts }
}

/** After the user confirms: take the incoming text for the conflicting fields too. */
export function forceFill(plan: FillPlan, incoming: TaskText): Omit<FillPlan, 'conflicts'> {
  const next = { ...plan.next }
  const auto = { ...plan.auto }
  for (const field of plan.conflicts) {
    next[field] = incoming[field]
    auto[field] = incoming[field]
  }
  return { next, auto }
}

/** Switching to "write my own" clears only text PR Hub put there. */
export function clearAutoFilled(current: TaskText, auto: AutoFilled): TaskText {
  return {
    title: isUserEdited(current.title, auto.title) ? current.title : '',
    description: isUserEdited(current.description, auto.description) ? current.description : ''
  }
}

function fitTitle(title: string): string {
  return title.length > LIMITS.title ? `${title.slice(0, LIMITS.title - 1).trimEnd()}…` : title
}

export function taskFromPr(pr: PrMetadata): TaskText {
  return { title: fitTitle(pr.title), description: pr.body || pr.title }
}

export function taskFromIssue(issue: IssueDetails): TaskText {
  return { title: fitTitle(issue.title), description: issue.body || issue.title }
}

export const SOURCE_LABELS: Record<TaskSource, string> = {
  issue: 'Linked issue',
  pr: 'PR title and description',
  manual: 'Write my own'
}

const LARGE_FILES = 50
const LARGE_LINES = 2000

export function changeSummary(pr: PrMetadata): string {
  const parts: string[] = []
  if (pr.changedFiles !== null)
    parts.push(`${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}`)
  if (pr.additions !== null && pr.deletions !== null)
    parts.push(`+${pr.additions} −${pr.deletions}`)
  return parts.join(' · ')
}

/** Things worth knowing before paying for a review. They warn; they never block. */
export function intakeWarnings(pr: PrMetadata): string[] {
  const warnings: string[] = []
  if (pr.draft) warnings.push('This PR is a draft, so the author may still be working on it.')
  if (pr.state === 'merged') warnings.push('This PR is already merged.')
  else if (pr.state === 'closed') warnings.push('This PR is closed.')
  const lines = (pr.additions ?? 0) + (pr.deletions ?? 0)
  if ((pr.changedFiles ?? 0) >= LARGE_FILES || lines >= LARGE_LINES) {
    warnings.push(
      `This is a large PR (${changeSummary(pr)}). The review will take longer and cost more, and may miss details.`
    )
  }
  if (pr.bodyTruncated) {
    warnings.push(
      `The PR description is longer than ${LIMITS.description.toLocaleString('en-US')} characters and was cut.`
    )
  }
  return warnings
}
