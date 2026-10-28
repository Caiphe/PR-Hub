// Typed IPC contract shared by main, preload and renderer. See PLAN.md "IPC contract".
import type { Findings } from './findings'
import type { PostMode, PostResult, PreviewResult } from './github'
import type { HistoryEntry, HistorySummary } from './history'
import type { ReviewInput } from './validate'

export const IPC = {
  startReview: 'review:start',
  cancelReview: 'review:cancel',
  reviewEvent: 'review:event',
  listHistory: 'history:list',
  getHistory: 'history:get',
  previewPost: 'github:preview',
  post: 'github:post',
  getSettings: 'settings:get',
  setAlwaysOnTop: 'settings:set-always-on-top',
  settingsChanged: 'settings:changed',
  newReview: 'app:new-review',
  replayFixture: 'dev:replay-fixture'
} as const

export interface Settings {
  /** Keep the window above other windows ("pin on top"). */
  alwaysOnTop: boolean
}

/** Dev-only fixture replay modes: the full review, markdown only, or a mid-run failure. */
export const REPLAY_VARIANTS = ['full', 'no-findings', 'error'] as const
export type ReplayVariant = (typeof REPLAY_VARIANTS)[number]

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
  /** Finished reviews, newest first. */
  listHistory(): Promise<HistorySummary[]>
  getHistory(id: string): Promise<HistoryEntry | null>
  /** Builds (but doesn't send) the GitHub review for the selected findings of a saved review. */
  previewPost(reviewId: string, findingIds: string[], mode: PostMode): Promise<PreviewResult>
  /** Submits a preview exactly as shown. Each preview can be posted once. */
  post(previewId: string): Promise<PostResult>
  getSettings(): Promise<Settings>
  setAlwaysOnTop(pinned: boolean): Promise<Settings>
  /** Settings changed elsewhere (e.g. the menu-bar menu); returns an unsubscribe function. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /** "New Review" chosen from the menu-bar menu; returns an unsubscribe function. */
  onNewReview(listener: () => void): () => void
  /** Development builds only: replays fixtures/sample-stream.jsonl as a review. */
  replayFixture(variant: ReplayVariant): Promise<StartReviewResult>
}
