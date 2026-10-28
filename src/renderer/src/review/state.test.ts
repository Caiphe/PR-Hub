import { describe, expect, it } from 'vitest'
import type { ReviewEvent, ReviewEventBody, ReviewResult } from '@shared/ipc'
import { reviewReducer, type ReviewAction, type ReviewState } from './state'

const input = { title: 'T', prUrl: 'https://github.com/a/b/pull/1', description: 'D' }
const result: ReviewResult = {
  markdown: '## PR review',
  findings: null,
  costUsd: 0.5,
  durationMs: 1000,
  deniedTools: []
}
const ev = (body: ReviewEventBody, reviewId = 'r1'): ReviewAction => ({
  type: 'event',
  event: { ...body, reviewId } satisfies ReviewEvent,
  now: 50
})
const run = (...actions: ReviewAction[]): ReviewState | null =>
  actions.reduce<ReviewState | null>(reviewReducer, null)
const start: ReviewAction = { type: 'start', requestId: 1, input, now: 0 }
const started: ReviewAction = { type: 'started', requestId: 1, reviewId: 'r1', now: 10 }

describe('reviewReducer', () => {
  it('replays events that arrived before the id was known', () => {
    const s = run(start, ev({ type: 'status', message: 'Starting Claude Code' }), started)
    expect(s?.reviewId).toBe('r1')
    expect(s?.phase).toBe('running')
    expect(s?.steps.map((x) => x.label)).toEqual(['Starting Claude Code'])
    expect(s?.pending).toEqual([])
  })

  it('collapses repeated step labels and ignores other reviews', () => {
    const s = run(
      start,
      started,
      ev({ type: 'tool', tool: 'Read', label: 'Reading a.ts' }),
      ev({ type: 'tool', tool: 'Read', label: 'Reading a.ts' }),
      ev({ type: 'tool', tool: 'Read', label: 'Reading other' }, 'someone-else'),
      ev({ type: 'tool', tool: 'Read', label: 'Reading b.ts' })
    )
    expect(s?.steps.map((x) => x.label)).toEqual(['Reading a.ts', 'Reading b.ts'])
  })

  it('records the result and stops accepting events when done', () => {
    const s = run(
      start,
      started,
      ev({ type: 'done', result }),
      ev({ type: 'error', message: 'late' })
    )
    expect(s).toMatchObject({ phase: 'done', result, error: null, endedAt: 50 })
  })

  it('records errors and cancellation', () => {
    expect(run(start, started, ev({ type: 'error', message: 'boom' }))).toMatchObject({
      phase: 'error',
      error: 'boom'
    })
    expect(run(start, started, ev({ type: 'cancelled' }))?.phase).toBe('cancelled')
  })

  it('fails the start when the main process rejects it', () => {
    const s = run(start, { type: 'startFailed', requestId: 1, error: 'claude not found', now: 5 })
    expect(s).toMatchObject({ phase: 'error', error: 'claude not found', endedAt: 5 })
  })

  it('ignores a late started (and its events) after the start failed', () => {
    const failed: ReviewAction = { type: 'startFailed', requestId: 1, error: 'x', now: 1 }
    const s = run(start, failed, ev({ type: 'status', message: 'm' }), started)
    expect(s).toMatchObject({ phase: 'error', reviewId: null, pending: [] })
  })

  it('ignores replies to an abandoned start', () => {
    const second: ReviewAction = { type: 'start', requestId: 2, input, now: 100 }
    const s = run(start, second, started)
    expect(s).toMatchObject({ requestId: 2, reviewId: null, phase: 'starting' })
  })

  it('opens a saved review as a finished, read-only state', () => {
    const s = run(start, {
      type: 'open',
      requestId: 2,
      entry: {
        id: 'old',
        input,
        startedAt: 100,
        endedAt: 400,
        status: 'done',
        result,
        error: null
      }
    })
    expect(s).toMatchObject({
      reviewId: 'old',
      phase: 'done',
      fromHistory: true,
      result,
      startedAt: 100,
      endedAt: 400
    })
    // Stray events for the old id must not change a finished review.
    expect(reviewReducer(s, ev({ type: 'error', message: 'x' }, 'old'))?.phase).toBe('done')
  })

  it('records GitHub posts on the current review', () => {
    const record = {
      at: 1,
      url: 'https://github.com/a/b/pull/1#r',
      mode: 'comment' as const,
      findingIds: ['f1']
    }
    const s = run(start, started, ev({ type: 'done', result }), { type: 'posted', record })
    expect(s?.posted).toEqual([record])
  })

  it('resets to no review', () => {
    expect(run(start, { type: 'reset' })).toBeNull()
  })
})
