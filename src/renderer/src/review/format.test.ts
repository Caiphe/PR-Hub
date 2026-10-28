import { describe, expect, it } from 'vitest'
import { codeFence, formatCost, formatDuration, languageForFile, prLabel } from './format'

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

  it('picks a fence longer than any backtick run in the code', () => {
    expect(codeFence('a = 1\n', 'python')).toBe('```python\na = 1\n```')
    expect(codeFence('x = ```y```')).toBe('````\nx = ```y```\n````')
  })
})
