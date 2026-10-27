import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { extractFindings } from './extractFindings'
import { parseStreamLine, type StreamResult } from './streamParser'

// fixtures/sample-stream.jsonl is a real run of the reviewer against
// https://github.com/sindresorhus/slugify/pull/82 (thinking_tokens lines removed).
const lines = readFileSync(join(__dirname, '../../fixtures/sample-stream.jsonl'), 'utf8').split(
  '\n'
)
const workDir = JSON.parse(lines[0]).cwd as string

describe('real review stream', () => {
  const parsed = lines.flatMap((line) => parseStreamLine(line, { workDir }))
  const labels = parsed.flatMap((p) =>
    p.kind === 'event' && p.event.type === 'tool' ? [p.event.label] : []
  )
  const result = parsed.find((p) => p.kind === 'result')?.result as StreamResult

  it('produces readable progress labels', () => {
    expect(labels[0]).toBe('Fetching the PR')
    expect(labels).toContain('Reading index.js')
  })

  it('ends with a successful result and no denied tools', () => {
    expect(result).toMatchObject({ isError: false, deniedTools: [] })
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('yields clean markdown and valid findings', () => {
    const { markdown, findings, findingsError } = extractFindings(result.text)
    expect(findingsError).toBeUndefined()
    expect(markdown.startsWith('## PR review:')).toBe(true)
    expect(markdown).not.toContain('```json')
    expect(findings?.verdict).toBe('approve')
    expect(findings?.requirements.every((r) => r.status === 'done')).toBe(true)
  })
})
