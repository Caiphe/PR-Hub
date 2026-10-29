// Typed IPC contract shared by main, preload and renderer. See PLAN.md "IPC contract".
import type { Findings } from './findings'
import type {
  ConnectionStatus,
  InspectIssueResult,
  InspectPrResult,
  PostMode,
  PostResult,
  PreviewResult
} from './github'
import type { HistoryEntry, HistorySummary } from './history'
import type { ReviewInput } from './validate'

export const IPC = {
  startReview: 'review:start',
  cancelReview: 'review:cancel',
  reviewEvent: 'review:event',
  listHistory: 'history:list',
  getHistory: 'history:get',
  setHistoryPinned: 'history:set-pinned',
  deleteHistory: 'history:delete',
  exportHistory: 'history:export',
  previewPost: 'github:preview',
  post: 'github:post',
  verifyPost: 'github:verify-post',
  githubStatus: 'github:status',
  inspectPr: 'github:inspect-pr',
  inspectIssue: 'github:inspect-issue',
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

export type HistoryExportFormat = 'markdown' | 'json'

/** fileName is the saved file's name only; full paths never reach the renderer. */
export type ExportHistoryResult =
  | { status: 'saved'; fileName: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

/** 'missing': the entry was already gone. */
export type DeleteHistoryResult = 'deleted' | 'cancelled' | 'missing'

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
  /** headSha: the PR commit that was reviewed, when the app could read it. */
  | { type: 'done'; result: ReviewResult; headSha?: string }
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
  /** Pins (keeps past the history limit) or unpins an entry; null if it no longer exists. */
  setHistoryPinned(id: string, pinned: boolean): Promise<HistorySummary | null>
  /**
   * Asks for confirmation in a native dialog, then removes the entry and its local files.
   * Local only: nothing on GitHub changes.
   */
  deleteHistory(id: string): Promise<DeleteHistoryResult>
  /** Saves one review as Markdown or JSON through a native save dialog. */
  exportHistory(id: string, format: HistoryExportFormat): Promise<ExportHistoryResult>
  /** Builds (but doesn't send) the GitHub review for the selected findings of a saved review. */
  previewPost(reviewId: string, findingIds: string[], mode: PostMode): Promise<PreviewResult>
  /**
   * Submits a preview exactly as shown; a preview can only ever become one review. After an
   * unclear outcome it first looks for the review on GitHub. `force` sends even when that check
   * fails, and is only for an explicit "post anyway" decision.
   */
  post(previewId: string, options?: { force?: boolean }): Promise<PostResult>
  /** Looks for an unclear submission on GitHub. Read-only. */
  verifyPost(previewId: string): Promise<PostResult>
  /**
   * Read-only check of the gh login and, when a PR link is given, whether that PR can be read.
   * Never writes to GitHub and never returns a token.
   */
  githubStatus(prUrl?: string): Promise<ConnectionStatus>
  /** Read-only PR metadata for the intake form. Works for public PRs without a gh login. */
  inspectPr(prUrl: string): Promise<InspectPrResult>
  /** Title and body of an issue the user chose as the task. Read-only. */
  inspectIssue(issueUrl: string): Promise<InspectIssueResult>
  getSettings(): Promise<Settings>
  setAlwaysOnTop(pinned: boolean): Promise<Settings>
  /** Settings changed elsewhere (e.g. the menu-bar menu); returns an unsubscribe function. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /** "New Review" chosen from the menu-bar menu; returns an unsubscribe function. */
  onNewReview(listener: () => void): () => void
  /** Development builds only: replays fixtures/sample-stream.jsonl as a review. */
  replayFixture(variant: ReplayVariant): Promise<StartReviewResult>
}
