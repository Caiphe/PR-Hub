// Typed IPC contract shared by main, preload and renderer. See PLAN.md "IPC contract".
import type { Findings } from './findings'
import type { ReviewInput } from './validate'

export const IPC = {
  startReview: 'review:start',
  cancelReview: 'review:cancel',
  reviewEvent: 'review:event'
} as const

export type StartReviewResult = { ok: true; reviewId: string } | { ok: false; error: string }

export interface ReviewResult {
  /** The human-readable review with the trailing JSON block removed. */
  markdown: string
  /** Null when the model didn't emit a valid findings block; the UI falls back to markdown. */
  findings: Findings | null
  findingsError?: string
  costUsd: number | null
  durationMs: number
  /** Tools the headless session tried to use but wasn't allowed to (for tuning the allowlist). */
  deniedTools: string[]
}

export type ReviewEventBody =
  | { type: 'status'; message: string }
  | { type: 'tool'; tool: string; label: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ReviewResult }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }

export type ReviewEvent = ReviewEventBody & { reviewId: string }

export interface PrHubApi {
  startReview(input: ReviewInput): Promise<StartReviewResult>
  cancelReview(reviewId: string): Promise<void>
  /** Subscribes to review events; returns an unsubscribe function. */
  onReviewEvent(listener: (event: ReviewEvent) => void): () => void
}
