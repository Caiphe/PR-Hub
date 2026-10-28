import type { PostRecord } from '@shared/github'
import type { HistoryEntry } from '@shared/history'
import type { ReviewEvent, ReviewResult } from '@shared/ipc'
import type { ReviewInput } from '@shared/validate'

export type Phase = 'starting' | 'running' | 'done' | 'error' | 'cancelled'

export interface Step {
  id: number
  kind: 'status' | 'tool'
  label: string
}

export interface ReviewState {
  /** Increments per start, so a slow reply from an abandoned start can't hijack a newer one. */
  requestId: number
  input: ReviewInput
  isReplay: boolean
  /** Opened from history: read-only, nothing is running. */
  fromHistory: boolean
  /** Reviews posted to GitHub from this result. */
  posted: PostRecord[]
  reviewId: string | null
  phase: Phase
  steps: Step[]
  /** Latest assistant narration, shown under the progress steps. */
  lastText: string | null
  startedAt: number
  endedAt: number | null
  result: ReviewResult | null
  error: string | null
  /** Events that arrived before startReview() returned the id (main emits immediately). */
  pending: ReviewEvent[]
}

export type ReviewAction =
  | { type: 'start'; requestId: number; input: ReviewInput; isReplay?: boolean; now: number }
  | { type: 'started'; requestId: number; reviewId: string; now: number }
  | { type: 'startFailed'; requestId: number; error: string; now: number }
  | { type: 'event'; event: ReviewEvent; now: number }
  | { type: 'open'; requestId: number; entry: HistoryEntry }
  | { type: 'posted'; record: PostRecord }
  | { type: 'reset' }

const TERMINAL: Phase[] = ['done', 'error', 'cancelled']

export function isTerminal(phase: Phase): boolean {
  return TERMINAL.includes(phase)
}

function applyEvent(state: ReviewState, event: ReviewEvent, now: number): ReviewState {
  if (isTerminal(state.phase)) return state
  switch (event.type) {
    case 'status':
    case 'tool': {
      const label = event.type === 'status' ? event.message : event.label
      // Collapse repeats (e.g. several reads of the same file in a row).
      if (state.steps.at(-1)?.label === label) return { ...state, phase: 'running' }
      const step: Step = { id: state.steps.length, kind: event.type, label }
      return { ...state, phase: 'running', steps: [...state.steps, step] }
    }
    case 'text':
      return { ...state, phase: 'running', lastText: event.text }
    case 'done':
      return { ...state, phase: 'done', result: event.result, endedAt: now }
    case 'error':
      return { ...state, phase: 'error', error: event.message, endedAt: now }
    case 'cancelled':
      return { ...state, phase: 'cancelled', endedAt: now }
  }
}

export function reviewReducer(state: ReviewState | null, action: ReviewAction): ReviewState | null {
  if (action.type === 'reset') return null
  if (action.type === 'start') {
    return {
      requestId: action.requestId,
      input: action.input,
      isReplay: action.isReplay ?? false,
      fromHistory: false,
      posted: [],
      reviewId: null,
      phase: 'starting',
      steps: [],
      lastText: null,
      startedAt: action.now,
      endedAt: null,
      result: null,
      error: null,
      pending: []
    }
  }
  if (action.type === 'open') {
    const { entry } = action
    return {
      requestId: action.requestId,
      input: entry.input,
      isReplay: false,
      fromHistory: true,
      posted: entry.posted ?? [],
      reviewId: entry.id,
      phase: entry.status,
      steps: [],
      lastText: null,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      result: entry.result,
      error: entry.error,
      pending: []
    }
  }
  if (!state) return null

  switch (action.type) {
    case 'started': {
      if (action.requestId !== state.requestId || state.reviewId) return state
      const mine = state.pending.filter((e) => e.reviewId === action.reviewId)
      const base: ReviewState = { ...state, reviewId: action.reviewId, pending: [] }
      return mine.reduce((s, e) => applyEvent(s, e, action.now), base)
    }
    case 'posted':
      return { ...state, posted: [...state.posted, action.record] }
    case 'startFailed':
      if (action.requestId !== state.requestId) return state
      return { ...state, phase: 'error', error: action.error, endedAt: action.now }
    case 'event':
      if (state.reviewId === null) {
        if (state.phase !== 'starting') return state
        return { ...state, pending: [...state.pending, action.event] }
      }
      if (action.event.reviewId !== state.reviewId) return state
      return applyEvent(state, action.event, action.now)
  }
}
