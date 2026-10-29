import { z } from 'zod'
import { FindingsSchema } from './findings'
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
    .optional()
})

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

/** What the recent-reviews list needs, without the full review text. */
export interface HistorySummary {
  id: string
  title: string
  prUrl: string
  startedAt: number
  status: HistoryEntry['status']
  verdict: z.infer<typeof FindingsSchema>['verdict'] | null
  costUsd: number | null
}

export function summarize(entry: HistoryEntry): HistorySummary {
  return {
    id: entry.id,
    title: entry.input.title,
    prUrl: entry.input.prUrl,
    startedAt: entry.startedAt,
    status: entry.status,
    verdict: entry.result?.findings?.verdict ?? null,
    costUsd: entry.result?.costUsd ?? null
  }
}
