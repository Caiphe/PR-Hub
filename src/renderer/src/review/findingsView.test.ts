import { describe, expect, it } from 'vitest'
import type { Finding } from '@shared/findings'
import {
  countBySeverity,
  describeFilters,
  filterFindings,
  githubFileUrl,
  groupFindings,
  isFiltering,
  navigationOrder,
  NO_FILTERS,
  stepFinding,
  type Filters
} from './findingsView'

const f = (id: string, severity: Finding['severity'], extra: Partial<Finding> = {}): Finding => ({
  id,
  severity,
  title: `Title ${id}`,
  body: '',
  ...extra
})

const findings: Finding[] = [
  f('f1', 'nit', { file: 'src/b.ts', line: 9, title: 'Rename variable' }),
  f('f2', 'blocking', { file: 'src/a.ts', line: 40, body: 'Null deref when user is missing' }),
  f('f3', 'should_fix', { file: 'src/a.ts', line: 3, suggestion: 'const timeout = 30' }),
  f('f4', 'blocking', { title: 'No tests for the redirect' }),
  f('f5', 'should_fix', { file: 'src/b.ts', line: 2 })
]
const selected = new Set(['f2', 'f3', 'f4'])
const posted = new Set(['f2'])
const ctx = { selected, posted }
const ids = (list: Finding[]): string[] => list.map((x) => x.id)
const filters = (over: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...over })

describe('filterFindings', () => {
  it('returns everything, in order, with no filters', () => {
    expect(ids(filterFindings(findings, NO_FILTERS, ctx))).toEqual(['f1', 'f2', 'f3', 'f4', 'f5'])
    expect(isFiltering(NO_FILTERS)).toBe(false)
  })

  it('filters by severity (any of several)', () => {
    expect(ids(filterFindings(findings, filters({ severities: ['blocking'] }), ctx))).toEqual([
      'f2',
      'f4'
    ])
    expect(
      ids(filterFindings(findings, filters({ severities: ['blocking', 'nit'] }), ctx))
    ).toEqual(['f1', 'f2', 'f4'])
  })

  it('filters by selection and posted state', () => {
    expect(ids(filterFindings(findings, filters({ selection: 'unselected' }), ctx))).toEqual([
      'f1',
      'f5'
    ])
    expect(ids(filterFindings(findings, filters({ posted: 'unposted' }), ctx))).toEqual([
      'f1',
      'f3',
      'f4',
      'f5'
    ])
  })

  it('searches title, body, file and suggestion, case-insensitively, all words', () => {
    const q = (query: string): string[] => ids(filterFindings(findings, filters({ query }), ctx))
    expect(q('rename')).toEqual(['f1'])
    expect(q('NULL deref')).toEqual(['f2'])
    expect(q('src/b.ts')).toEqual(['f1', 'f5'])
    expect(q('timeout = 30')).toEqual(['f3'])
    expect(q('null rename')).toEqual([])
    expect(q('   ')).toHaveLength(5)
  })

  it('composes filters with AND', () => {
    const all = filters({
      severities: ['blocking', 'should_fix'],
      selection: 'selected',
      posted: 'unposted',
      query: 'a.ts'
    })
    expect(ids(filterFindings(findings, all, ctx))).toEqual(['f3'])
  })

  it('never changes the selection', () => {
    const before = [...selected]
    filterFindings(findings, filters({ selection: 'unselected', query: 'x' }), ctx)
    groupFindings(findings, 'file')
    expect([...selected]).toEqual(before)
  })
})

describe('groupFindings', () => {
  it('groups by severity in fixed order', () => {
    const groups = groupFindings(findings, 'severity')
    expect(groups.map((g) => [g.title, ids(g.items)])).toEqual([
      ['Blocking', ['f2', 'f4']],
      ['Should fix', ['f3', 'f5']],
      ['Nits', ['f1']]
    ])
  })

  it('drops empty severity groups', () => {
    expect(groupFindings([findings[0]], 'severity').map((g) => g.key)).toEqual(['nit'])
  })

  it('groups by file alphabetically, then severity and line, with file-less findings last', () => {
    const groups = groupFindings(findings, 'file')
    expect(groups.map((g) => [g.title, ids(g.items)])).toEqual([
      ['src/a.ts', ['f2', 'f3']],
      ['src/b.ts', ['f5', 'f1']],
      ['Not tied to a file', ['f4']]
    ])
  })
})

describe('counts and navigation', () => {
  it('counts by severity', () => {
    expect(countBySeverity(findings)).toEqual({ blocking: 2, should_fix: 2, nit: 1 })
    expect(countBySeverity([])).toEqual({ blocking: 0, should_fix: 0, nit: 0 })
  })

  it('navigates in display order for each grouping', () => {
    expect(navigationOrder(groupFindings(findings, 'severity'))).toEqual([
      'f2',
      'f4',
      'f3',
      'f5',
      'f1'
    ])
    expect(navigationOrder(groupFindings(findings, 'file'))).toEqual(['f2', 'f3', 'f5', 'f1', 'f4'])
  })

  it('steps forward and back, starting at an end and stopping at the ends', () => {
    const order = ['a', 'b', 'c']
    expect(stepFinding(order, null, 1)).toBe('a')
    expect(stepFinding(order, null, -1)).toBe('c')
    expect(stepFinding(order, 'a', 1)).toBe('b')
    expect(stepFinding(order, 'c', 1)).toBe('c')
    expect(stepFinding(order, 'a', -1)).toBe('a')
    expect(stepFinding(order, 'hidden', 1)).toBe('a')
    expect(stepFinding([], 'a', 1)).toBeNull()
  })
})

describe('describeFilters', () => {
  it('lists active filters in words', () => {
    expect(describeFilters(NO_FILTERS)).toEqual([])
    expect(
      describeFilters(
        filters({ severities: ['blocking', 'nit'], posted: 'unposted', query: ' auth ' })
      )
    ).toEqual(['Blocking or Nits', 'not posted yet', 'matching “auth”'])
  })
})

describe('githubFileUrl', () => {
  const pr = 'https://github.com/acme/web/pull/42/files'
  const sha = '4cb427bf689a01fed190e50dfe2a703793d295d2'

  it('links to the line in the reviewed commit', () => {
    expect(githubFileUrl(pr, sha, 'src/app.ts', 12)).toBe(
      `https://github.com/acme/web/blob/${sha}/src/app.ts#L12`
    )
  })

  it('encodes spaces, Unicode and URL syntax in each path segment', () => {
    expect(githubFileUrl(pr, sha, 'docs/My File.md', 1)).toBe(
      `https://github.com/acme/web/blob/${sha}/docs/My%20File.md#L1`
    )
    expect(githubFileUrl(pr, sha, 'i18n/日本語/café.json', 3)).toBe(
      `https://github.com/acme/web/blob/${sha}/i18n/%E6%97%A5%E6%9C%AC%E8%AA%9E/caf%C3%A9.json#L3`
    )
    expect(githubFileUrl(pr, sha, 'a/b#c?d=1%.ts', 2)).toBe(
      `https://github.com/acme/web/blob/${sha}/a/b%23c%3Fd%3D1%25.ts#L2`
    )
  })

  it('returns null when the commit, file or line is missing or invalid', () => {
    expect(githubFileUrl(pr, null, 'a.ts', 1)).toBeNull()
    expect(githubFileUrl(pr, 'main', 'a.ts', 1)).toBeNull()
    expect(githubFileUrl(pr, sha, null, 1)).toBeNull()
    expect(githubFileUrl(pr, sha, 'a.ts', null)).toBeNull()
    expect(githubFileUrl(pr, sha, 'a.ts', 0)).toBeNull()
    expect(githubFileUrl(pr, sha, 'a.ts', 1.5)).toBeNull()
    expect(githubFileUrl('https://evil.example/pull/1', sha, 'a.ts', 1)).toBeNull()
  })

  it('refuses paths that could escape the file view', () => {
    for (const path of ['../secrets', 'a/../../b', '/etc/passwd', 'a//b', './a', 'a\\b', 'a\nb']) {
      expect(githubFileUrl(pr, sha, path, 1)).toBeNull()
    }
  })
})
