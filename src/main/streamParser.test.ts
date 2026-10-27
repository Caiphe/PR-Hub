import { describe, expect, it } from 'vitest'
import { parseStreamLine } from './streamParser'

const ctx = { workDir: '/data/reviews/abc' }
const line = (obj: unknown): string => JSON.stringify(obj)
const assistant = (...content: unknown[]): string =>
  line({ type: 'assistant', message: { role: 'assistant', content } })

describe('parseStreamLine', () => {
  it('maps the init event to a status', () => {
    const parsed = parseStreamLine(line({ type: 'system', subtype: 'init', tools: [] }), ctx)
    expect(parsed).toEqual([
      { kind: 'event', event: { type: 'status', message: 'Review session started' } }
    ])
  })

  it('ignores noise events, blank lines and invalid JSON', () => {
    expect(parseStreamLine(line({ type: 'system', subtype: 'thinking_tokens' }), ctx)).toEqual([])
    expect(parseStreamLine(line({ type: 'rate_limit_event' }), ctx)).toEqual([])
    expect(parseStreamLine(line({ type: 'user', message: { content: [] } }), ctx)).toEqual([])
    expect(parseStreamLine('', ctx)).toEqual([])
    expect(parseStreamLine('{not json', ctx)).toEqual([])
  })

  it('labels tool calls', () => {
    const parsed = parseStreamLine(
      assistant(
        { type: 'thinking', thinking: 'hmm' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'bash /s/scripts/fetch_pr.sh https://github.com/a/b/pull/1 /w/pr' }
        },
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: '/data/reviews/abc/pr/repo/src/a.ts' }
        },
        { type: 'tool_use', name: 'Read', input: { file_path: '/data/reviews/abc/pr/pr.diff' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'redirectTo' } },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'git log', description: 'Show history' }
        }
      ),
      ctx
    )
    expect(
      parsed.map((p) => (p.kind === 'event' && p.event.type === 'tool' ? p.event.label : null))
    ).toEqual([
      'Fetching the PR',
      'Reading src/a.ts',
      'Reading pr.diff',
      'Searching for "redirectTo"',
      'Running Show history'
    ])
  })

  it('emits non-empty assistant text', () => {
    const parsed = parseStreamLine(
      assistant({ type: 'text', text: '  ' }, { type: 'text', text: '## PR review' }),
      ctx
    )
    expect(parsed).toEqual([{ kind: 'event', event: { type: 'text', text: '## PR review' } }])
  })

  it('parses a successful result with denials', () => {
    const parsed = parseStreamLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'review text',
        total_cost_usd: 0.42,
        duration_ms: 61000,
        permission_denials: [
          { tool_name: 'Bash', tool_input: { command: 'npm test' } },
          { tool_name: 'Bash', tool_input: { command: 'npm test' } },
          { tool_name: 'Write', tool_input: { file_path: '/x' } }
        ]
      }),
      ctx
    )
    expect(parsed).toEqual([
      {
        kind: 'result',
        result: {
          isError: false,
          text: 'review text',
          costUsd: 0.42,
          durationMs: 61000,
          deniedTools: ['Bash(npm test)', 'Write']
        }
      }
    ])
  })

  it('treats error subtypes as errors', () => {
    const parsed = parseStreamLine(
      line({ type: 'result', subtype: 'error_max_turns', is_error: false }),
      ctx
    )
    expect(parsed[0]).toMatchObject({ kind: 'result', result: { isError: true, costUsd: null } })
  })
})
