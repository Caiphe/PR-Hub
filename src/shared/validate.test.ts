import { describe, expect, it } from 'vitest'
import { parseIssueUrl, parsePrUrl, validateReviewInput } from './validate'

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

describe('parsePrUrl: suffixes, forks and owners', () => {
  it('drops every page suffix, query and anchor', () => {
    for (const suffix of [
      '/commits',
      '/checks',
      '/files/',
      '?diff=split',
      '#issuecomment-1',
      '/files?w=1#r1'
    ]) {
      expect(parsePrUrl(`https://github.com/acme/web/pull/42${suffix}`)?.url).toBe(
        'https://github.com/acme/web/pull/42'
      )
    }
  })

  it('keeps owner and repo spelling (fork owners, dots, underscores)', () => {
    expect(parsePrUrl('https://github.com/my-fork-1/Some_Repo.js/pull/3')).toMatchObject({
      owner: 'my-fork-1',
      repo: 'Some_Repo.js'
    })
  })

  it('rejects invalid owners', () => {
    for (const owner of ['-acme', 'acme-', 'ac_me', 'a'.repeat(40), 'ac.me']) {
      expect(parsePrUrl(`https://github.com/${owner}/web/pull/1`)).toBeNull()
    }
    expect(parsePrUrl(`https://github.com/${'a'.repeat(39)}/web/pull/1`)).not.toBeNull()
  })

  it('rejects repository names that would escape an API path', () => {
    expect(parsePrUrl('https://github.com/acme/../pull/1')).toBeNull()
    expect(parsePrUrl('https://github.com/acme/./pull/1')).toBeNull()
  })

  it('rejects numbers that are too large to be safe', () => {
    expect(parsePrUrl('https://github.com/acme/web/pull/99999999999999999999')).toBeNull()
  })
})

describe('parseIssueUrl', () => {
  it('parses and canonicalizes issue links', () => {
    expect(parseIssueUrl('https://github.com/acme/web/issues/9#issuecomment-2')).toEqual({
      owner: 'acme',
      repo: 'web',
      number: 9,
      url: 'https://github.com/acme/web/issues/9'
    })
  })

  it('rejects PR links and bad repos', () => {
    expect(parseIssueUrl('https://github.com/acme/web/pull/9')).toBeNull()
    expect(parseIssueUrl('https://github.com/acme/../issues/9')).toBeNull()
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
