import { readFileSync } from 'fs'
import { looksLikeProse } from '../shared/markdown'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { Finding, Findings } from '../shared/findings'
import { buildReview, commentableLines, commentableMap, type PrFile } from './githubReview'

// Real files response for https://github.com/sindresorhus/slugify/pull/75.
const files: PrFile[] = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/github/files-75.json'), 'utf8')
)
const ZWSP = '​'

const finding = (id: string, overrides: Partial<Finding> = {}): Finding => ({
  id,
  severity: 'blocking',
  title: `Finding ${id}`,
  file: 'index.js',
  line: 110,
  body: 'Explanation.',
  suggestion: null,
  ...overrides
})

const findings = (...items: Finding[]): Findings => ({
  verdict: 'request_changes',
  summary: 'Two problems.',
  requirements: [],
  findings: items
})

const base = {
  mode: 'comment' as const,
  headSha: 'abc123',
  commentable: commentableMap(files),
  headMoved: false
}

describe('commentableLines', () => {
  it('collects added and context lines from every hunk, skipping removed lines', () => {
    const lines = commentableLines(files[0].patch)
    expect([...lines]).toEqual([1, 2, 3, 4, 106, 107, 108, 109, 110, 111, 112, 113])
  })

  it('handles removals, no-newline markers and missing patches', () => {
    const patch = '@@ -10,3 +10,2 @@\n a\n-b\n+c\n\\ No newline at end of file'
    expect([...commentableLines(patch)]).toEqual([10, 11])
    expect(commentableLines(undefined).size).toBe(0)
  })
})

describe('looksLikeProse', () => {
  it('flags instructions but not code', () => {
    expect(looksLikeProse('Add a guard before the replace call')).toBe(true)
    expect(looksLikeProse('Consider using escapeStringRegexp here.')).toBe(true)
    expect(looksLikeProse('const sep = escapeStringRegexp(options.separator);')).toBe(false)
    expect(looksLikeProse('return string;')).toBe(false)
    expect(looksLikeProse('Promise.resolve(value)')).toBe(false)
    expect(looksLikeProse('String name = user.getName();')).toBe(false)
    expect(looksLikeProse('add(1, 2)')).toBe(false)
  })
})

describe('buildReview', () => {
  it('posts findings on diff lines inline and the rest in the body', () => {
    const built = buildReview({
      ...base,
      findings: findings(
        finding('f1'),
        finding('f2', { line: 50 }),
        finding('f3', { file: null, line: null, title: 'Missing test' }),
        finding('f4', { file: 'other.js', line: 3 })
      ),
      selectedIds: ['f1', 'f2', 'f3', 'f4']
    })

    expect(built.payload).toMatchObject({ commit_id: 'abc123', event: 'COMMENT' })
    expect(built.payload.comments).toEqual([
      { path: 'index.js', line: 110, side: 'RIGHT', body: expect.stringContaining('Finding f1') }
    ])
    expect(built.inBody).toEqual([
      { findingId: 'f2', reason: 'index.js:50 is not part of the PR diff' },
      { findingId: 'f3', reason: 'not tied to a specific line' },
      { findingId: 'f4', reason: 'other.js:3 is not part of the PR diff' }
    ])
    expect(built.payload.body).toContain('### Other findings')
    expect(built.payload.body).toContain('**🔴 Blocking: Missing test**')
    expect(built.payload.body).toContain('`index.js:50`')
    expect(built.payload.body).toContain('1 inline comment(s) below')
  })

  it('only includes selected findings', () => {
    const built = buildReview({
      ...base,
      findings: findings(finding('f1'), finding('f2')),
      selectedIds: ['f2']
    })
    expect(built.comments.map((c) => c.findingId)).toEqual(['f2'])
    expect(built.payload.body).not.toContain('Finding f1')
  })

  it('maps request_changes mode to the REQUEST_CHANGES event', () => {
    const built = buildReview({
      ...base,
      mode: 'request_changes',
      findings: findings(),
      selectedIds: []
    })
    expect(built.payload.event).toBe('REQUEST_CHANGES')
    expect(built.payload.body).toContain('🔁 Request changes')
  })

  it('uses a suggestion block only for single-line suggestions', () => {
    const built = buildReview({
      ...base,
      findings: findings(
        finding('one', { suggestion: 'const x = escape(sep);\n' }),
        finding('many', { suggestion: 'const a = 1;\nconst b = 2;' })
      ),
      selectedIds: ['one', 'many']
    })
    expect(built.comments[0].body).toContain('```suggestion\nconst x = escape(sep);\n```')
    expect(built.comments[1].body).not.toContain('```suggestion')
    expect(built.comments[1].body).toContain('Suggested change:\n\n```javascript\nconst a = 1;')
  })

  it('never turns prose "suggestions" into one-click suggestion blocks', () => {
    // Real output from a review of slugify#75: advice placed in the suggestion field.
    const prose =
      'Add a guard: if (!options.separator) { return string; } before line 110, or combine the logic with line 98.'
    const built = buildReview({
      ...base,
      findings: findings(finding('f3', { suggestion: prose })),
      selectedIds: ['f3']
    })
    expect(built.comments[0].body).not.toContain('```')
    expect(built.comments[0].body).toContain(`Suggested fix: ${prose}`)
  })

  it('moves everything to the body when the PR has new commits', () => {
    const built = buildReview({
      ...base,
      headMoved: true,
      findings: findings(finding('f1')),
      selectedIds: ['f1']
    })
    expect(built.payload.comments).toEqual([])
    expect(built.inBody[0].reason).toBe('the PR has new commits since the review')
    expect(built.payload.body).toContain('### Findings')
  })

  it('neutralizes @mentions in text but not in suggestions', () => {
    const built = buildReview({
      ...base,
      findings: {
        ...findings(finding('f1', { body: 'cc @maintainer', suggestion: '@decorator' })),
        summary: 'Ask @team'
      },
      selectedIds: ['f1']
    })
    expect(built.comments[0].body).toContain(`cc @${ZWSP}maintainer`)
    expect(built.comments[0].body).toContain('```suggestion\n@decorator\n```')
    expect(built.payload.body).toContain(`Ask @${ZWSP}team`)
  })
})
