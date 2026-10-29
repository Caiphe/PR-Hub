import { describe, expect, it } from 'vitest'
import type { PrMetadata } from '@shared/github'
import {
  changeSummary,
  clearAutoFilled,
  currentPrKey,
  forceFill,
  intakeWarnings,
  isCurrent,
  isUserEdited,
  planFill,
  taskFromIssue,
  taskFromPr
} from './intake'

const pr = (overrides: Partial<PrMetadata> = {}): PrMetadata => ({
  url: 'https://github.com/acme/widgets/pull/7',
  owner: 'acme',
  repo: 'widgets',
  number: 7,
  title: 'Fix login redirect',
  body: 'Users should land where they started.',
  bodyTruncated: false,
  author: 'contributor',
  draft: false,
  state: 'open',
  baseRef: 'main',
  headLabel: 'fix-login',
  headSha: 'a'.repeat(40),
  changedFiles: 3,
  additions: 41,
  deletions: 7,
  linkedIssues: [],
  via: 'gh',
  ...overrides
})

const incoming = { title: 'PR title', description: 'PR body' }

describe('planFill: never overwrite what the user wrote', () => {
  it('fills empty fields', () => {
    const plan = planFill({ title: '', description: '' }, {}, incoming)
    expect(plan).toEqual({ next: incoming, auto: incoming, conflicts: [] })
  })

  it('replaces text PR Hub filled in that the user left alone', () => {
    const auto = { title: 'Old', description: 'Old body' }
    const plan = planFill(auto, auto, incoming)
    expect(plan.next).toEqual(incoming)
    expect(plan.conflicts).toEqual([])
  })

  it('keeps edited text and reports it as a conflict', () => {
    const auto = { title: 'Old', description: 'Old body' }
    const plan = planFill({ title: 'Old', description: 'Old body, plus my notes' }, auto, incoming)
    expect(plan.next).toEqual({ title: 'PR title', description: 'Old body, plus my notes' })
    expect(plan.conflicts).toEqual(['description'])
  })

  it('treats pre-filled text with no auto-fill record as the user’s', () => {
    const plan = planFill({ title: 'Mine', description: 'Mine too' }, {}, incoming)
    expect(plan.next).toEqual({ title: 'Mine', description: 'Mine too' })
    expect(plan.conflicts).toEqual(['title', 'description'])
  })

  it("doesn't call identical text a conflict", () => {
    const plan = planFill({ title: 'PR title', description: 'x' }, {}, incoming)
    expect(plan.conflicts).toEqual(['description'])
    expect(plan.auto.title).toBe('PR title')
  })

  it('treats whitespace-only text as empty', () => {
    expect(isUserEdited('   ', undefined)).toBe(false)
    expect(isUserEdited('a', 'a')).toBe(false)
    expect(isUserEdited('a', 'b')).toBe(true)
  })

  it('replaces conflicting fields only after confirmation', () => {
    const plan = planFill({ title: 'Mine', description: '' }, {}, incoming)
    expect(forceFill(plan, incoming)).toEqual({ next: incoming, auto: incoming })
  })
})

describe('clearAutoFilled', () => {
  it('clears only untouched auto-filled text', () => {
    const auto = { title: 'PR title', description: 'PR body' }
    expect(clearAutoFilled({ title: 'PR title', description: 'PR body + mine' }, auto)).toEqual({
      title: '',
      description: 'PR body + mine'
    })
  })
})

describe('stale responses', () => {
  it('matches responses to the canonical form of the current link', () => {
    const url = 'https://github.com/acme/widgets/pull/7'
    expect(isCurrent(url, `${url}/files#diff-1`)).toBe(true)
    expect(isCurrent(url, 'https://github.com/acme/widgets/pull/8')).toBe(false)
    expect(isCurrent(url, 'https://github.com/acme/widgets/pull/')).toBe(false)
    expect(currentPrKey('not a link')).toBeNull()
  })
})

describe('task text', () => {
  it('uses the PR title and body, falling back to the title', () => {
    expect(taskFromPr(pr())).toEqual({
      title: 'Fix login redirect',
      description: 'Users should land where they started.'
    })
    expect(taskFromPr(pr({ body: '' })).description).toBe('Fix login redirect')
  })

  it('fits long titles into the task title limit', () => {
    const title = taskFromPr(pr({ title: 't'.repeat(300) })).title
    expect(title).toHaveLength(200)
    expect(title.endsWith('…')).toBe(true)
  })

  it('uses the issue title and body', () => {
    const issue = {
      url: 'u',
      number: 1,
      title: 'Bug',
      body: '',
      bodyTruncated: false,
      state: 'open' as const
    }
    expect(taskFromIssue(issue)).toEqual({ title: 'Bug', description: 'Bug' })
  })
})

describe('summary and warnings', () => {
  it('summarizes the change size', () => {
    expect(changeSummary(pr())).toBe('3 files · +41 −7')
    expect(changeSummary(pr({ changedFiles: 1, additions: null, deletions: null }))).toBe('1 file')
  })

  it('warns, without blocking, about drafts, closed PRs, large PRs and cut descriptions', () => {
    expect(intakeWarnings(pr())).toEqual([])
    const all = intakeWarnings(
      pr({ draft: true, state: 'merged', changedFiles: 80, bodyTruncated: true })
    )
    expect(all).toHaveLength(4)
    expect(all[0]).toMatch(/draft/)
    expect(all[1]).toMatch(/merged/)
    expect(all[2]).toMatch(/large PR \(80 files/)
    expect(intakeWarnings(pr({ additions: 1500, deletions: 600 }))[0]).toMatch(/large/)
  })
})
