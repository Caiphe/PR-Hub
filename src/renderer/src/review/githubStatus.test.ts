import { describe, expect, it } from 'vitest'
import type { ConnectionStatus } from '@shared/github'
import { accountLine, repoFor, repoLine, statusChip } from './githubStatus'

const status = (overrides: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  checkedAt: 1,
  cli: { installed: true, version: '2.101.0' },
  auth: { state: 'signed_in', login: 'octocat', tokenKind: 'fine_grained_pat', source: 'keyring' },
  posting: { state: 'unverified', message: 'm' },
  problems: [],
  ...overrides
})
const chip = (s: ConnectionStatus): string => statusChip({ kind: 'ready', status: s }).label

describe('statusChip', () => {
  it('labels each state', () => {
    expect(statusChip({ kind: 'checking' }).label).toBe('Checking GitHub…')
    expect(statusChip({ kind: 'failed', message: 'x' }).label).toBe('GitHub check failed')
    expect(chip(status())).toBe('Connected as @octocat')
    expect(chip(status({ cli: { installed: false }, auth: { state: 'unknown' } }))).toBe(
      'GitHub CLI unavailable'
    )
    expect(chip(status({ auth: { state: 'signed_out' } }))).toBe('Not signed in to GitHub')
  })

  it('asks for action when there is a problem or posting is unlikely', () => {
    const problem = { kind: 'not_found' as const, title: 't', message: 'm', actions: [] }
    expect(chip(status({ problems: [problem] }))).toBe('Action needed')
    expect(chip(status({ posting: { state: 'unlikely', message: 'm' } }))).toBe('Action needed')
    expect(statusChip({ kind: 'ready', status: status({ problems: [problem] }) }).tone).toBe('warn')
  })

  it("doesn't alarm when gh is just missing: public reviews still work", () => {
    expect(statusChip({ kind: 'ready', status: status({ cli: { installed: false } }) }).tone).toBe(
      'muted'
    )
  })
})

describe('accountLine', () => {
  it('describes the login without any token', () => {
    expect(accountLine(status().auth)).toBe('@octocat · fine-grained token')
    expect(
      accountLine({ state: 'signed_in', login: 'a', tokenKind: 'oauth', source: 'GH_TOKEN' })
    ).toBe('@a · browser login · from GH_TOKEN')
    expect(accountLine({ state: 'invalid', login: 'a' })).toBe('@a · login no longer valid')
    expect(accountLine({ state: 'signed_out' })).toBe('Not signed in')
  })
})

describe('repoFor', () => {
  const checked = status({
    repo: { prUrl: 'https://github.com/a/b/pull/1', state: 'readable', private: false }
  })

  it('matches the canonical form of the current link', () => {
    expect(repoFor(checked, 'https://github.com/a/b/pull/1/files?x=1#y')).toBe(checked.repo)
  })

  it('hides a result for a link that has since changed', () => {
    expect(repoFor(checked, 'https://github.com/a/b/pull/2')).toBeUndefined()
    expect(repoFor(checked, 'not a link')).toBeUndefined()
    expect(repoFor(null, 'https://github.com/a/b/pull/1')).toBeUndefined()
  })
})

describe('repoLine', () => {
  it('summarizes each repository state', () => {
    expect(repoLine(undefined)).toBe('Not checked')
    expect(repoLine({ prUrl: 'u', state: 'skipped' })).toMatch(/needs a gh login/)
    expect(repoLine({ prUrl: 'u', state: 'not_readable' })).toBe("Can't read this PR")
    expect(repoLine({ prUrl: 'u', state: 'readable', private: true, isOwnPr: true })).toBe(
      'Readable · private · your PR'
    )
  })
})
