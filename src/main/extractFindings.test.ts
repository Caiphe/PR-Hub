import { describe, expect, it } from 'vitest'
import { extractFindings } from './extractFindings'

const findings = {
  verdict: 'request_changes',
  summary: 'Redirect is not validated.',
  requirements: [{ text: 'Return to original page', status: 'done', notes: 'auth.ts:12' }],
  findings: [
    {
      id: 'f1',
      severity: 'blocking',
      title: 'Open redirect',
      file: 'src/auth.ts',
      line: 12,
      body: 'next= is used unvalidated.',
      suggestion: null
    }
  ]
}
const fence = (body: string): string => '```json\n' + body + '\n```'
const review = '## PR review: Fix login (acme/web#42)\n\n**Verdict:** 🔁 Request changes'

describe('extractFindings', () => {
  it('splits markdown and a valid findings block', () => {
    const out = extractFindings(`${review}\n\n${fence(JSON.stringify(findings, null, 2))}\n`)
    expect(out.markdown).toBe(review)
    expect(out.findings?.verdict).toBe('request_changes')
    expect(out.findings?.findings[0]).toMatchObject({ id: 'f1', file: 'src/auth.ts', line: 12 })
    expect(out.findingsError).toBeUndefined()
  })

  it('returns markdown only when the block is missing', () => {
    const out = extractFindings(review)
    expect(out).toEqual({
      markdown: review,
      findings: null,
      findingsError: 'No findings block found'
    })
  })

  it('keeps the markdown and reports malformed JSON', () => {
    const out = extractFindings(`${review}\n\n${fence('{ "verdict": "approve", }')}`)
    expect(out.markdown).toBe(review)
    expect(out.findings).toBeNull()
    expect(out.findingsError).toMatch(/not valid JSON/)
  })

  it('reports schema mismatches', () => {
    const bad = { ...findings, verdict: 'lgtm' }
    const out = extractFindings(`${review}\n\n${fence(JSON.stringify(bad))}`)
    expect(out.findings).toBeNull()
    expect(out.findingsError).toMatch(/verdict/)
  })

  it('uses the last block when the review quotes JSON earlier', () => {
    const quoted = `${review}\n\nThe config now reads:\n${fence('{"debug": true}')}\n\nMore text.`
    const out = extractFindings(`${quoted}\n\n${fence(JSON.stringify(findings))}`)
    expect(out.findings?.summary).toBe('Redirect is not validated.')
    expect(out.markdown).toContain('"debug": true')
  })

  it('drops narration before the review heading and trailing rules', () => {
    const text = `I have all the information needed. Let me now write the review.\n\n---\n\n${review}\n\n---\n\n${fence(JSON.stringify(findings))}`
    expect(extractFindings(text).markdown).toBe(review)
  })

  it('keeps everything when there is no review heading', () => {
    expect(extractFindings('Could not fetch the PR.').markdown).toBe('Could not fetch the PR.')
  })

  it('makes repeated finding ids unique', () => {
    const dup = {
      ...findings,
      findings: [findings.findings[0], findings.findings[0], findings.findings[0]]
    }
    const out = extractFindings(fence(JSON.stringify(dup)))
    expect(out.findings?.findings.map((f) => f.id)).toEqual(['f1', 'f1-2', 'f1-3'])
  })

  it('fills defaults for optional arrays', () => {
    const out = extractFindings(fence('{"verdict": "approve"}'))
    expect(out.findings).toEqual({
      verdict: 'approve',
      summary: '',
      requirements: [],
      findings: []
    })
  })
})
