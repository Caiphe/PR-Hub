import { z } from 'zod'
import { FindingsSchema, type Finding, type Findings } from './findings'
import { ComparisonSchema, lifecycleCounts, OverrideSchema, type Lifecycle } from './incremental'
import { TASK_SOURCES } from './validate'

// Persisted review history. Only finished reviews are saved (done or failed);
// cancelled runs and dev fixture replays are not.

export const HistoryEntrySchema = z.object({
  id: z.string().min(1),
  input: z.object({
    title: z.string(),
    prUrl: z.string(),
    description: z.string(),
    // Older entries have no source; unknown values are dropped rather than failing the entry.
    taskSource: z.enum(TASK_SOURCES).optional().catch(undefined)
  }),
  startedAt: z.number(),
  endedAt: z.number(),
  status: z.enum(['done', 'error']),
  result: z
    .object({
      markdown: z.string(),
      findings: FindingsSchema.nullable(),
      findingsError: z.string().optional(),
      costUsd: z.number().nullable(),
      durationMs: z.number(),
      deniedTools: z.array(z.string())
    })
    .nullable(),
  error: z.string().nullable(),
  /** PR head commit the review saw; lets posting detect new commits since. */
  headSha: z.string().optional(),
  /** Reviews posted to GitHub from this entry. */
  posted: z
    .array(
      z.object({
        at: z.number(),
        url: z.string(),
        mode: z.enum(['comment', 'request_changes']),
        findingIds: z.array(z.string()),
        submissionId: z.string().optional()
      })
    )
    .optional(),
  /** Pinned entries are never trimmed by the history limit. Absent means not pinned. */
  pinned: z.boolean().optional().catch(undefined),
  /**
   * Set on an incremental review: the review it compared against (its parent), that review's
   * commit, and the finding-by-finding comparison (null if it couldn't be built). Absent: a full
   * review, which is what every entry saved before incremental reviews is.
   */
  incremental: z
    .object({
      parentId: z.string().min(1),
      comparedSha: z.string(),
      comparison: ComparisonSchema.nullable()
    })
    .optional(),
  /** An incremental review was asked for but ran as a full one, and why. */
  fallbackReason: z.string().optional(),
  /** Local decisions on uncertain comparison items. Never sent to GitHub. */
  overrides: z.record(OverrideSchema).optional()
})

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

type Severity = Finding['severity']

// Long enough for any findings summary the reviewer writes; the cap keeps list payloads small.
const SUMMARY_LIMIT = 600

/** What the history lists need, without the full review text (loaded on demand with get). */
export interface HistorySummary {
  id: string
  title: string
  prUrl: string
  startedAt: number
  endedAt: number
  durationMs: number
  status: HistoryEntry['status']
  verdict: Findings['verdict'] | null
  /** The findings summary, shortened; empty when there are no structured findings. */
  summary: string
  costUsd: number | null
  headSha: string | null
  /** Null when the review has no structured findings. */
  counts: Record<Severity, number> | null
  /** How many reviews were posted to GitHub from this entry, and how many distinct findings. */
  postCount: number
  postedFindings: number
  pinned: boolean
  /** Incremental reviews: what it compared against, and the counts per lifecycle. */
  incremental: {
    parentId: string
    comparedSha: string
    counts: Record<Lifecycle, number> | null
  } | null
  fallbackReason: string | null
}

export function summarize(entry: HistoryEntry): HistorySummary {
  const findings = entry.result?.findings ?? null
  let counts: HistorySummary['counts'] = null
  if (findings) {
    counts = { blocking: 0, should_fix: 0, nit: 0 }
    for (const f of findings.findings) counts[f.severity]++
  }
  const summary = findings?.summary ?? ''
  const posted = entry.posted ?? []
  return {
    id: entry.id,
    title: entry.input.title,
    prUrl: entry.input.prUrl,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.result?.durationMs ?? Math.max(0, entry.endedAt - entry.startedAt),
    status: entry.status,
    verdict: findings?.verdict ?? null,
    summary: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}…` : summary,
    costUsd: entry.result?.costUsd ?? null,
    headSha: entry.headSha ?? null,
    counts,
    postCount: posted.length,
    postedFindings: new Set(posted.flatMap((p) => p.findingIds)).size,
    pinned: entry.pinned === true,
    incremental: entry.incremental
      ? {
          parentId: entry.incremental.parentId,
          comparedSha: entry.incremental.comparedSha,
          counts: entry.incremental.comparison
            ? lifecycleCounts(entry.incremental.comparison, entry.overrides)
            : null
        }
      : null,
    fallbackReason: entry.fallbackReason ?? null
  }
}
