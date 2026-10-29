import { describe, expect, it } from 'vitest'
import { HistoryEntrySchema } from './history'

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
