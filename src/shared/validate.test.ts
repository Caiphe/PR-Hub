import { describe, expect, it } from 'vitest'
import { parsePrUrl, validateReviewInput } from './validate'

describe('parsePrUrl', () => {
  it('parses a plain PR URL', () => {
    expect(parsePrUrl('https://github.com/acme/web-app/pull/42')).toEqual({
      owner: 'acme',
      repo: 'web-app',
      number: 42,
      url: 'https://github.com/acme/web-app/pull/42'
    })
  })

  it('accepts a trailing slash and surrounding whitespace', () => {
    expect(parsePrUrl('  https://github.com/acme/web-app/pull/42/ ')?.number).toBe(42)
  })

  it('accepts the /files suffix and normalizes it away', () => {
    expect(parsePrUrl('https://github.com/acme/web-app/pull/42/files')?.url).toBe(
      'https://github.com/acme/web-app/pull/42'
    )
  })

  it('accepts query strings and anchors', () => {
    expect(parsePrUrl('https://github.com/a/b.js/pull/7#discussion_r1')?.repo).toBe('b.js')
    expect(parsePrUrl('https://www.github.com/a/b/pull/7?w=1')?.number).toBe(7)
  })

  it('rejects non-GitHub hosts', () => {
    expect(parsePrUrl('https://gitlab.com/acme/web-app/pull/42')).toBeNull()
    expect(parsePrUrl('https://github.com.evil.io/acme/web-app/pull/42')).toBeNull()
  })

  it('rejects a missing or invalid PR number', () => {
    expect(parsePrUrl('https://github.com/acme/web-app/pull/')).toBeNull()
    expect(parsePrUrl('https://github.com/acme/web-app/pull/abc')).toBeNull()
    expect(parsePrUrl('https://github.com/acme/web-app/pull/0')).toBeNull()
  })

  it('rejects issues and non-PR pages', () => {
    expect(parsePrUrl('https://github.com/acme/web-app/issues/42')).toBeNull()
    expect(parsePrUrl('https://github.com/acme/web-app')).toBeNull()
  })
})

describe('validateReviewInput', () => {
  const valid = {
    title: 'Fix login redirect',
    prUrl: 'https://github.com/acme/web-app/pull/42',
    description: 'After login, users should land on the page they came from.'
  }

  it('returns no errors for valid input', () => {
    expect(validateReviewInput(valid)).toEqual({})
  })

  it('flags each empty or whitespace-only field', () => {
    const errors = validateReviewInput({ title: ' ', prUrl: '', description: '\n' })
    expect(Object.keys(errors).sort()).toEqual(['description', 'prUrl', 'title'])
  })

  it('flags a malformed PR link', () => {
    expect(validateReviewInput({ ...valid, prUrl: 'github.com/acme' }).prUrl).toMatch(/GitHub PR/)
  })

  it('flags an overlong title', () => {
    expect(validateReviewInput({ ...valid, title: 'x'.repeat(201) }).title).toBeDefined()
  })
})
