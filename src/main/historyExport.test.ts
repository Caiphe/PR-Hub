import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { HistoryEntrySchema, type HistoryEntry } from '../shared/history'
import {
  EXPORT_FORMAT_ID,
  exportFileName,
  exportJson,
  exportMarkdown,
  toExport
} from './historyExport'

const NOW = Date.UTC(2026, 9, 29, 12, 0)
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/history/v1.json'), 'utf8')
).entries.map((e: unknown) => HistoryEntrySchema.parse(e)) as HistoryEntry[]
const [posted, , noFindings, failed] = fixture

const TOKENS = ['ghp_' + 'A'.repeat(36), 'github_pat_' + 'B'.repeat(40), 'gho_' + 'C'.repeat(36)]
const leaky: HistoryEntry = {
  ...posted,
  input: { ...posted.input, description: `Use ${TOKENS[0]} to test` },
  result: {
    ...posted.result!,
    markdown: `Found Authorization: token ${TOKENS[1]} in the diff`,
    findings: {
      ...posted.result!.findings!,
      findings: [{ ...posted.result!.findings!.findings[0], body: `Hardcoded ${TOKENS[2]}` }]
    }
  }
}

describe('toExport / exportJson', () => {
  it('matches the documented schema', () => {
    const out = toExport(posted, NOW)
    expect(out).toEqual({
      format: EXPORT_FORMAT_ID,
      version: 1,
      exportedAt: '2026-10-29T12:00:00.000Z',
      review: {
        id: 'posted-with-submission',
        status: 'done',
        startedAt: new Date(posted.startedAt).toISOString(),
        endedAt: new Date(posted.endedAt).toISOString(),
        durationMs: 180000,
        costUsd: 0.41,
        pinned: false,
        task: {
          title: 'Add retry to webhook sender',
          description: 'Retry failed webhooks three times',
          source: 'issue'
        },
        pullRequest: {
          url: 'https://github.com/acme/hooks/pull/12',
          owner: 'acme',
          repo: 'hooks',
          number: 12,
          reviewedCommit: '0123456789abcdef0123456789abcdef01234567'
        },
        verdict: 'request_changes',
        summary: 'Retries never back off.',
        requirements: posted.result!.findings!.requirements,
        findings: posted.result!.findings!.findings,
        findingsError: null,
        markdown: '## PR review\n\nLooks close.',
        error: null,
        posted: [
          {
            at: new Date(1761700300000).toISOString(),
            url: 'https://github.com/acme/hooks/pull/12#pullrequestreview-1',
            mode: 'request_changes',
            findingIds: ['f1']
          }
        ]
      }
    })
  })

  it('leaves out app-internal fields and the raw stream', () => {
    const text = exportJson(posted, NOW)
    expect(text).not.toContain('submissionId')
    expect(text).not.toContain('s-1')
    expect(text).not.toContain('deniedTools')
    expect(text).not.toContain('WebFetch')
    expect(text).not.toContain('stream')
    expect(JSON.parse(text).format).toBe(EXPORT_FORMAT_ID)
  })

  it('handles failed reviews and reviews without findings', () => {
    expect(toExport(failed, NOW).review).toMatchObject({
      status: 'error',
      verdict: null,
      findings: [],
      markdown: null,
      error: 'claude exited with code 1',
      task: { source: null },
      pullRequest: { reviewedCommit: null },
      durationMs: 30000
    })
    expect(toExport(noFindings, NOW).review.findingsError).toBe('No findings block')
  })

  it('redacts token-like values everywhere', () => {
    for (const text of [exportJson(leaky, NOW), exportMarkdown(leaky, NOW)]) {
      for (const token of TOKENS) expect(text).not.toContain(token)
      expect(text).toContain('[redacted]')
    }
  })
})

describe('exportMarkdown', () => {
  it('renders a readable review', () => {
    const md = exportMarkdown(posted, NOW)
    expect(md).toMatch(/^# Add retry to webhook sender\n/)
    expect(md).toContain(
      '- **Pull request:** [acme/hooks#12](https://github.com/acme/hooks/pull/12)'
    )
    expect(md).toContain('`0123456789abcdef0123456789abcdef01234567`')
    expect(md).toContain('- **Verdict:** Request changes')
    expect(md).toContain('- **Duration:** 3m 00s · **Cost:** $0.41')
    expect(md).toContain('as a change request (1 finding)')
    expect(md).toContain('## Task\n\nRetry failed webhooks three times')
    expect(md).toContain('- **Partial:** Retry three times')
    expect(md).toContain('### Blocking: No backoff\n\n`src/send.ts:14`\n\nTight loop')
    expect(md).toContain('### Nit: Typo')
    expect(md).toContain('## Full review\n\n## PR review\n\nLooks close.')
    expect(md).toContain('Exported from PR Hub on 2026-10-29 12:00 UTC.')
  })

  it('shows the error of a failed review', () => {
    const md = exportMarkdown(failed, NOW)
    expect(md).toContain('- **Status:** Failed')
    expect(md).toContain('## Error\n\n```\nclaude exited with code 1\n```')
    expect(md).not.toContain('## Findings')
  })
})

describe('exportFileName', () => {
  it('builds a safe name from the PR and date', () => {
    expect(exportFileName(posted, 'markdown')).toBe(
      `pr-hub-acme-hooks-12-${new Date(posted.startedAt).toISOString().slice(0, 10)}.md`
    )
    expect(exportFileName(posted, 'json')).toMatch(/\.json$/)
    const odd = { ...posted, input: { ...posted.input, prUrl: '../../etc/passwd' } }
    expect(exportFileName(odd, 'markdown')).toMatch(/^pr-hub-review-\d{4}-\d{2}-\d{2}\.md$/)
  })
})
