import { describe, expect, it } from 'vitest'
import { HistoryEntrySchema, summarize } from './history'

const entry = {
  id: 'r1',
  input: { title: 'T', prUrl: 'https://github.com/a/b/pull/1', description: 'D' },
  startedAt: 1,
  endedAt: 2,
  status: 'done',
  result: null,
  error: null
}

describe('HistoryEntrySchema task source', () => {
  it('reads entries saved before task sources existed', () => {
    const parsed = HistoryEntrySchema.parse(entry)
    expect(parsed.input.taskSource).toBeUndefined()
  })

  it('keeps a known source and drops an unknown one without losing the entry', () => {
    const withPr = { ...entry, input: { ...entry.input, taskSource: 'pr' } }
    expect(HistoryEntrySchema.parse(withPr).input.taskSource).toBe('pr')
    const odd = { ...entry, input: { ...entry.input, taskSource: 'telepathy' } }
    expect(HistoryEntrySchema.parse(odd).input).toEqual(entry.input)
  })
})

describe('summarize', () => {
  const done = HistoryEntrySchema.parse({
    ...entry,
    headSha: 'a'.repeat(40),
    pinned: true,
    result: {
      markdown: 'long review text',
      findings: {
        verdict: 'request_changes',
        summary: 'x'.repeat(700),
        findings: [
          { id: 'f1', severity: 'blocking', title: 'A' },
          { id: 'f2', severity: 'nit', title: 'B' },
          { id: 'f3', severity: 'nit', title: 'C' }
        ]
      },
      costUsd: 0.2,
      durationMs: 5000,
      deniedTools: []
    },
    posted: [
      { at: 3, url: 'u1', mode: 'comment', findingIds: ['f1'] },
      { at: 4, url: 'u2', mode: 'comment', findingIds: ['f1', 'f2'] }
    ]
  })

  it('carries what the history lists show, without the review text', () => {
    const s = summarize(done)
    expect(s).toMatchObject({
      verdict: 'request_changes',
      counts: { blocking: 1, should_fix: 0, nit: 2 },
      headSha: 'a'.repeat(40),
      durationMs: 5000,
      postCount: 2,
      postedFindings: 2,
      pinned: true
    })
    expect(s.summary).toHaveLength(601)
    expect(JSON.stringify(s)).not.toContain('long review text')
  })

  it('handles failed entries saved before pins existed', () => {
    expect(summarize(HistoryEntrySchema.parse(entry))).toMatchObject({
      verdict: null,
      counts: null,
      summary: '',
      durationMs: 1,
      postCount: 0,
      pinned: false,
      headSha: null
    })
  })
})
