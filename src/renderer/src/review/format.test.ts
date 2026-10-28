import { describe, expect, it } from 'vitest'
import { codeFence, languageForFile } from '@shared/markdown'
import { formatCost, formatDuration, formatRelative, prLabel } from './format'

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(42_400)).toBe('42s')
    expect(formatDuration(223_359)).toBe('3m 43s')
    expect(formatDuration(60_000)).toBe('1m 00s')
  })

  it('formats costs', () => {
    expect(formatCost(null)).toBeNull()
    expect(formatCost(0.5207)).toBe('$0.52')
    expect(formatCost(0.004)).toBe('<$0.01')
  })

  it('labels PR links', () => {
    expect(prLabel('https://github.com/acme/web/pull/42')).toBe('acme/web#42')
    expect(prLabel('not a url')).toBe('not a url')
  })

  it('maps file extensions to highlight languages', () => {
    expect(languageForFile('src/a.tsx')).toBe('typescript')
    expect(languageForFile('index.js')).toBe('javascript')
    expect(languageForFile('Makefile')).toBe('')
    expect(languageForFile(null)).toBe('')
  })

  it('formats relative times', () => {
    const now = Date.UTC(2026, 9, 28, 12)
    expect(formatRelative(now - 20_000, now)).toBe('just now')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(formatRelative(now - 30 * 86_400_000, now)).toMatch(/Sep/)
    expect(formatRelative(now + 5000, now)).toBe('just now')
  })

  it('picks a fence longer than any backtick run in the code', () => {
    expect(codeFence('a = 1\n', 'python')).toBe('```python\na = 1\n```')
    expect(codeFence('x = ```y```')).toBe('````\nx = ```y```\n````')
  })
})
