import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionStatus } from '../shared/github'
import { assessPosting, checkConnection } from './githubHealth'
import { parseAuthStatus } from './githubPoster'

// A stand-in `gh` that answers from canned output chosen by FAKE_GH_SCENARIO and logs every
// call, so tests can check that only read-only commands ran. Nothing here reaches GitHub.
// Its tokens are deliberately unmasked, to prove they never make it into a status.
const FAKE_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123'
const FAKE_PAT = 'github_pat_11FAKE0123456789_abcdefghijklmnopqrstuvwxyzABCDEF'

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
s="$FAKE_GH_SCENARIO"
case "$1" in
  --version) echo "gh version 2.101.0 (2026-09-15)"; exit 0 ;;
  auth)
    case "$s" in
      signed-out) echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1 ;;
      invalid) printf 'github.com\\n  X Failed to log in to github.com account octocat (keyring)\\n  - Active account: true\\n  - The token in keyring is invalid.\\n' >&2; exit 1 ;;
      offline) printf 'error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com\\n' >&2; exit 1 ;;
      classic) printf "github.com\\n  ✓ Logged in to github.com account octocat (GH_TOKEN)\\n  - Active account: true\\n  - Token: ${FAKE_TOKEN}\\n  - Token scopes: 'gist', 'read:org', 'repo'\\n"; exit 0 ;;
      *) printf "github.com\\n  ✓ Logged in to github.com account octocat (keyring)\\n  - Active account: true\\n  - Git operations protocol: https\\n  - Token: ${FAKE_PAT}\\n"; exit 0 ;;
    esac ;;
  api)
    case "$s" in
      pr-403) echo '{"message":"Resource not accessible by personal access token","status":"403"}'; echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;;
      pr-404) echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      pr-rate) echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2; exit 1 ;;
      slow) sleep 5; exit 0 ;;
      own) echo '{"author":"octocat","private":false}'; exit 0 ;;
      *) echo '{"author":"someone-else","private":false}'; exit 0 ;;
    esac ;;
esac
echo "unexpected: $*" >&2; exit 2
`

let dir: string
let gh: string
let log: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prhub-fake-gh-'))
  gh = join(dir, 'gh')
  log = join(dir, 'calls.log')
  await writeFile(gh, FAKE_GH)
  await chmod(gh, 0o755)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const PR = 'https://github.com/acme/widgets/pull/7/files'
const check = (scenario: string, prUrl?: string, timeoutMs?: number): Promise<ConnectionStatus> =>
  checkConnection({
    gh,
    env: { PATH: process.env.PATH, FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log },
    prUrl,
    timeoutMs
  })

describe('checkConnection with a fake gh', () => {
  it('reports gh missing without failing, and never needs it for public reviews', async () => {
    const status = await checkConnection({ gh: null, env: {}, prUrl: PR })
    expect(status.cli.installed).toBe(false)
    expect(status.problems.map((p) => p.kind)).toEqual(['cli_missing'])
    expect(status.problems[0].message).toMatch(/Public PRs can be reviewed without it/)
    expect(status.repo).toEqual({
      prUrl: 'https://github.com/acme/widgets/pull/7',
      state: 'skipped'
    })
    expect(status.posting.state).toBe('unavailable')
  })

  it('maps a fine-grained login with a readable PR to "unverified" posting', async () => {
    const status = await check('fine', PR)
    expect(status.cli).toEqual({ installed: true, version: '2.101.0' })
    expect(status.auth).toMatchObject({
      state: 'signed_in',
      login: 'octocat',
      tokenKind: 'fine_grained_pat',
      source: 'keyring'
    })
    expect(status.repo).toMatchObject({ state: 'readable', author: 'someone-else', isOwnPr: false })
    expect(status.problems).toEqual([])
    expect(status.posting.state).toBe('unverified')
    expect(status.posting.message).toMatch(
      /acme\/widgets with Pull requests set to "Read and write"/
    )
    expect(status.posting.message).toMatch(/can't confirm that without posting/)
  })

  it('maps a classic token with the repo scope to "likely"', async () => {
    const status = await check('classic', PR)
    expect(status.auth).toMatchObject({
      tokenKind: 'classic_pat',
      scopes: ['gist', 'read:org', 'repo'],
      source: 'GH_TOKEN'
    })
    expect(status.posting.state).toBe('likely')
  })

  it('notes when the PR is your own', async () => {
    const status = await check('own', PR)
    expect(status.repo?.isOwnPr).toBe(true)
    expect(status.posting.message).toMatch(/only allows Comment/)
  })

  it('explains a fine-grained token that lacks the repository', async () => {
    const status = await check('pr-403', PR)
    expect(status.repo?.state).toBe('not_readable')
    expect(status.problems.map((p) => p.kind)).toEqual(['fine_grained_repo_access'])
    expect(status.posting.state).toBe('unlikely')
  })

  it('explains a missing PR and rate limiting', async () => {
    expect((await check('pr-404', PR)).problems[0]).toMatchObject({ kind: 'not_found' })
    expect((await check('pr-rate', PR)).problems[0]).toMatchObject({ kind: 'rate_limited' })
  })

  it('reports signed-out and invalid logins and skips the PR check', async () => {
    const out = await check('signed-out', PR)
    expect(out.auth.state).toBe('signed_out')
    expect(out.repo?.state).toBe('skipped')
    expect(out.problems.map((p) => p.kind)).toEqual(['signed_out'])

    const bad = await check('invalid', PR)
    expect(bad.auth).toMatchObject({ state: 'invalid', login: 'octocat' })
    expect(bad.problems.map((p) => p.kind)).toEqual(['invalid_login'])
    expect(bad.posting.state).toBe('unavailable')
  })

  it('treats a network failure as itself, not as a login problem', async () => {
    const status = await check('offline')
    expect(status.auth.state).toBe('unknown')
    expect(status.problems.map((p) => p.kind)).toEqual(['network'])
  })

  it('times out slow PR checks', async () => {
    const status = await check('slow', PR, 300)
    expect(status.problems.map((p) => p.kind)).toEqual(['timeout'])
  })

  it('checks only the login when no valid PR link is given', async () => {
    const status = await check('fine', 'https://example.com/not-a-pr')
    expect(status.repo).toBeUndefined()
  })

  it('never includes a token, even when gh prints one unmasked', async () => {
    for (const scenario of ['fine', 'classic', 'invalid', 'pr-403', 'offline']) {
      const text = JSON.stringify(await check(scenario, PR))
      expect(text).not.toContain(FAKE_TOKEN)
      expect(text).not.toContain(FAKE_PAT)
      expect(text).not.toMatch(/github_pat_|gh[pousr]_[A-Za-z0-9]/)
    }
  })

  it('runs only read-only gh commands', async () => {
    await rm(log, { force: true })
    for (const scenario of ['fine', 'classic', 'pr-403']) await check(scenario, PR)
    const { readFile } = await import('fs/promises')
    const calls = (await readFile(log, 'utf8')).trim().split('\n')
    for (const call of calls) {
      expect(call).toMatch(
        /^(--version|auth status --hostname github\.com|api repos\/acme\/widgets\/pulls\/7 --jq .*)$/
      )
      expect(call).not.toMatch(/--method|-X |POST|token/)
    }
  })
})

describe('parseAuthStatus', () => {
  it('prefers the active account when several are signed in', () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account first (keyring)',
      '  - Active account: false',
      "  - Token scopes: 'repo'",
      '  ✓ Logged in to github.com account second (keyring)',
      '  - Active account: true',
      '  - Token: gho_************************************',
      "  - Token scopes: 'gist', 'read:org'"
    ].join('\n')
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed_in',
      login: 'second',
      source: 'keyring',
      tokenKind: 'oauth',
      scopes: ['gist', 'read:org']
    })
  })

  it('reads older "Logged in … as" output and hides config file paths', () => {
    const out = '  ✓ Logged in to github.com as octocat (/Users/me/.config/gh/hosts.yml)'
    expect(parseAuthStatus(out)).toEqual({ state: 'signed_in', login: 'octocat', source: 'config' })
  })

  it('treats empty output as signed out', () => {
    expect(parseAuthStatus('')).toEqual({ state: 'signed_out' })
  })
})

describe('assessPosting', () => {
  it('needs the repo scope for private repositories', () => {
    const posting = assessPosting(
      { state: 'signed_in', login: 'me', tokenKind: 'oauth', scopes: ['public_repo'] },
      { prUrl: PR, state: 'readable', private: true },
      'acme/widgets'
    )
    expect(posting.state).toBe('unlikely')
    expect(posting.command).toMatch(/gh auth refresh .* --scopes repo/)
  })

  it("is honest when it can't tell", () => {
    const posting = assessPosting({ state: 'signed_in', login: 'me' }, undefined, undefined)
    expect(posting.state).toBe('unverified')
  })
})
