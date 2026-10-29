import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { PostRecord } from '@shared/github'
import type { Override } from '@shared/incremental'
import type { ReplayVariant, StartReviewOptions, StartReviewResult } from '@shared/ipc'
import type { ReviewInput } from '@shared/validate'
import { isTerminal, reviewReducer, type ReviewState } from './state'

const REPLAY_INPUT: ReviewInput = {
  title: 'Fix slugifyWithCounter returning duplicate slugs',
  prUrl: 'https://github.com/sindresorhus/slugify/pull/82',
  description: '(fixture replay)'
}

export interface ReviewControls {
  state: ReviewState | null
  start(input: ReviewInput, options?: StartReviewOptions): void
  replay(variant: ReplayVariant): void
  /** Shows a saved review from history. */
  open(id: string): Promise<void>
  cancel(): void
  /** Runs the same task again; `options` asks for an incremental re-review. */
  retry(options?: StartReviewOptions): void
  /** Settles an uncertain comparison item locally (null clears it). */
  setOverride(key: string, value: Override | null): void
  /** Records a successful GitHub post on the current review. */
  markPosted(record: PostRecord): void
  reset(): void
}

export function useReview(): ReviewControls {
  const [state, dispatch] = useReducer(reviewReducer, null)
  const requestCounter = useRef(0)
  const lastReplay = useRef<ReplayVariant>('full')

  useEffect(
    () => window.api.onReviewEvent((event) => dispatch({ type: 'event', event, now: Date.now() })),
    []
  )

  const launch = useCallback(
    async (
      input: ReviewInput,
      isReplay: boolean,
      call: () => Promise<StartReviewResult>,
      options?: StartReviewOptions
    ) => {
      const requestId = ++requestCounter.current
      dispatch({ type: 'start', requestId, input, options, isReplay, now: Date.now() })
      let res: StartReviewResult
      try {
        res = await call()
      } catch (error) {
        res = { ok: false, error: (error as Error).message }
      }
      if (res.ok) dispatch({ type: 'started', requestId, reviewId: res.reviewId, now: Date.now() })
      else dispatch({ type: 'startFailed', requestId, error: res.error, now: Date.now() })
    },
    []
  )

  const start = useCallback(
    (input: ReviewInput, options?: StartReviewOptions) =>
      // Only the parent id crosses IPC, whatever the caller passed.
      void launch(
        input,
        false,
        () =>
          window.api.startReview(
            input,
            options?.incrementalFrom ? { incrementalFrom: options.incrementalFrom } : undefined
          ),
        options
      ),
    [launch]
  )

  const replay = useCallback(
    (variant: ReplayVariant) => {
      lastReplay.current = variant
      void launch(REPLAY_INPUT, true, () => window.api.replayFixture(variant))
    },
    [launch]
  )

  const open = useCallback(async (id: string) => {
    const requestId = ++requestCounter.current
    const entry = await window.api.getHistory(id)
    // Ignore if another review was started while this one loaded.
    if (entry && requestId === requestCounter.current) dispatch({ type: 'open', requestId, entry })
  }, [])

  const cancel = useCallback(() => {
    if (state?.reviewId && !isTerminal(state.phase)) void window.api.cancelReview(state.reviewId)
  }, [state])

  const retry = useCallback(
    (options?: StartReviewOptions) => {
      if (!state) return
      if (state.isReplay) replay(lastReplay.current)
      else start(state.input, options)
    },
    [state, start, replay]
  )

  const setOverride = useCallback(
    (key: string, value: Override | null) => {
      const id = state?.reviewId
      if (!id || state?.isReplay) return
      void window.api
        .setOverride(id, key, value)
        .then((entry) => entry && dispatch({ type: 'overrides', overrides: entry.overrides ?? {} }))
        .catch(() => {})
    },
    [state?.reviewId, state?.isReplay]
  )

  const reset = useCallback(() => {
    if (state?.reviewId && !isTerminal(state.phase)) void window.api.cancelReview(state.reviewId)
    dispatch({ type: 'reset' })
  }, [state])

  const markPosted = useCallback((record: PostRecord) => dispatch({ type: 'posted', record }), [])

  return { state, start, replay, open, cancel, retry, reset, markPosted, setOverride }
}
