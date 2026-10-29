import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIssueUrl, parsePrUrl, type PrRef } from '../shared/validate'
import {
  cleanText,
  clearInspectCache,
  inspectIssue,
  inspectPr,
  linkedIssues,
  toMetadata,
  type InspectDeps
} from './prInspect'

// GitHub is faked twice: a stand-in `gh` script, and an injected fetch for the public API.
// Nothing here touches the network.

const FIXTURES = join(__dirname, '../../fixtures/github')
const REF = parsePrUrl('https://github.com/acme/widgets/pull/7')!
let pull: unknown

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case "$FAKE_GH_SCENARIO" in
  ok) cat "$FAKE_GH_BODY"; exit 0 ;;
  signed-out) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4 ;;
  forbidden) echo '{"message":"Resource not accessible by personal access token"}'; echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;;
esac
exit 2
`

let dir: string
let gh: string
let log: string

beforeAll(async () => {
  pull = JSON.parse(await readFile(join(FIXTURES, 'pull-fork-draft.json'), 'utf8'))
  dir = await mkdtemp(join(tmpdir(), 'prhub-inspect-'))
  gh = join(dir, 'gh')
  log = join(dir, 'calls.log')
  await writeFile(gh, FAKE_GH)
  await chmod(gh, 0o755)
  await writeFile(join(dir, 'pull.json'), JSON.stringify(pull))
})
afterAll(() => rm(dir, { recursive: true, force: true }))
beforeEach(async () => {
  clearInspectCache()
  await rm(log, { force: true })
})

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function deps(scenario: string | null, fetchImpl?: typeof fetch): InspectDeps {
  return {
    gh: scenario ? gh : null,
    env: {
      PATH: process.env.PATH,
      FAKE_GH_SCENARIO: scenario ?? '',
      FAKE_GH_LOG: log,
      FAKE_GH_BODY: join(dir, 'pull.json')
    },
    fetch: fetchImpl ?? (vi.fn() as unknown as typeof fetch),
    timeoutMs: 2000
  }
}

describe('linkedIssues', () => {
  const base = { owner: 'acme', repo: 'widgets' }

  it('finds closing keywords in every form GitHub recognizes', () => {
    const body =
      'Fixes #12. Closes: #13, resolved acme/other#4 and fix https://github.com/a/b/issues/5'
    expect(linkedIssues(body, base).map((i) => [i.url, i.relation])).toEqual([
      ['https://github.com/acme/widgets/issues/12', 'closes'],
      ['https://github.com/acme/widgets/issues/13', 'closes'],
      ['https://github.com/acme/other/issues/4', 'closes'],
      ['https://github.com/a/b/issues/5', 'closes']
    ])
  })

  it('lists plain issue links as mentions, after closing ones and without duplicates', () => {
    const body =
      'See https://github.com/acme/widgets/issues/9 and fixes #9; also https://github.com/x/y/issues/2'
    expect(linkedIssues(body, base).map((i) => [i.number, i.relation])).toEqual([
      [9, 'closes'],
      [2, 'mentions']
    ])
  })

  it('ignores template placeholders in comments and code', () => {
    const body = '<!-- Fixes #(issue) or fixes #1 -->\n```\ncloses #2\n```\n`fixes #3`'
    expect(linkedIssues(body, base)).toEqual([])
  })

  it('ignores bare references, PR links and invalid owners', () => {
    const body = 'related to #4, https://github.com/a/b/pull/5, fixes -bad/repo#6'
    expect(linkedIssues(body, base)).toEqual([])
  })

  it('caps the list', () => {
    const body = Array.from({ length: 9 }, (_, i) => `fixes #${i + 1}`).join(' ')
    expect(linkedIssues(body, base)).toHaveLength(5)
  })
})

describe('cleanText', () => {
  it('normalizes newlines and removes control and bidi-override characters', () => {
    expect(cleanText('a\r\nb\u202Ec\u0007d\te', 100)).toEqual(['a\nbcd\te', false])
  })

  it('caps length and says so', () => {
    expect(cleanText('x'.repeat(10), 4)).toEqual(['xxxx', true])
    expect(cleanText(null, 4)).toEqual(['', false])
  })
})

describe('toMetadata', () => {
  it('returns the safe subset of a fork draft PR', () => {
    const pr = toMetadata(REF, pull, 'gh')
    expect(pr).toMatchObject({
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Fix login redirect after session timeout',
      author: 'contributor',
      draft: true,
      state: 'open',
      baseRef: 'main',
      headLabel: 'contributor:fix-login',
      headSha: '4cb427bf689a01fed190e50dfe2a703793d295d2',
      changedFiles: 3,
      additions: 41,
      deletions: 7,
      bodyTruncated: false,
      via: 'gh'
    })
    expect(pr.body).not.toContain('\r')
    expect(pr.linkedIssues.map((i) => `${i.owner}/${i.repo}#${i.number}`)).toEqual([
      'acme/widgets#12',
      'acme-labs/shared.js#3',
      'acme/widgets#40'
    ])
    // Only the listed fields are returned; nothing else from the API response leaks through.
    expect(Object.keys(pr).sort()).toEqual(
      [
        'additions',
        'author',
        'baseRef',
        'body',
        'bodyTruncated',
        'changedFiles',
        'deletions',
        'draft',
        'headLabel',
        'headSha',
        'linkedIssues',
        'number',
        'owner',
        'repo',
        'state',
        'title',
        'url',
        'via'
      ].sort()
    )
  })

  it('shows a same-repository head as just the branch, and merged PRs as merged', () => {
    const same = {
      ...(pull as object),
      merged_at: '2026-01-01T00:00:00Z',
      state: 'closed',
      head: { ref: 'x', label: 'acme:x', sha: 'a'.repeat(40), repo: { full_name: 'acme/widgets' } }
    }
    expect(toMetadata(REF, same, 'gh')).toMatchObject({ headLabel: 'x', state: 'merged' })
  })

  it('cuts an overlong body to the task description limit', () => {
    const pr = toMetadata(REF, { ...(pull as object), body: 'y'.repeat(25_000) }, 'gh')
    expect(pr.body).toHaveLength(20_000)
    expect(pr.bodyTruncated).toBe(true)
  })

  it('rejects data that is not a pull request', () => {
    expect(() => toMetadata(REF, { message: 'hi' }, 'gh')).toThrow(/doesn't understand/)
  })
})

describe('inspectPr', () => {
  it('reads through gh when it works', async () => {
    const fetchImpl = vi.fn()
    const res = await inspectPr(REF, deps('ok', fetchImpl as unknown as typeof fetch))
    expect(res.ok && res.pr.via).toBe('gh')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await readFile(log, 'utf8')).trim()).toBe('api repos/acme/widgets/pulls/7')
  })

  it('falls back to the public API when gh is signed out or missing', async () => {
    const fetchImpl = vi.fn(async () => json(200, pull))
    const signedOut = await inspectPr(REF, deps('signed-out', fetchImpl as unknown as typeof fetch))
    expect(signedOut.ok && signedOut.pr.via).toBe('public_api')
    clearInspectCache()
    const missing = await inspectPr(REF, deps(null, fetchImpl as unknown as typeof fetch))
    expect(missing.ok && missing.pr.via).toBe('public_api')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/pulls/7',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.anything() })
      })
    )
  })

  it("doesn't fall back when gh is signed in but refused", async () => {
    const fetchImpl = vi.fn()
    const res = await inspectPr(REF, deps('forbidden', fetchImpl as unknown as typeof fetch))
    expect(res).toMatchObject({ ok: false, problem: { kind: 'fine_grained_repo_access' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('explains public API failures', async () => {
    const notFound = vi.fn(async () => json(404, { message: 'Not Found' }))
    const res = await inspectPr(REF, deps(null, notFound as unknown as typeof fetch))
    expect(res).toMatchObject({ ok: false, problem: { kind: 'not_found' } })
    expect(!res.ok && res.problem?.actions.join(' ')).toMatch(/private, sign in/)

    const limited = vi.fn(async () =>
      json(403, { message: 'API rate limit exceeded for 203.0.113.1.' })
    )
    expect(await inspectPr(REF, deps(null, limited as unknown as typeof fetch))).toMatchObject({
      ok: false,
      problem: { kind: 'rate_limited' }
    })

    const offline = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    })
    expect(await inspectPr(REF, deps(null, offline as unknown as typeof fetch))).toMatchObject({
      ok: false,
      problem: { kind: 'network' }
    })
  })

  it('caches answers briefly within the session', async () => {
    const fetchImpl = vi.fn(async () => json(200, pull))
    const d = deps(null, fetchImpl as unknown as typeof fetch)
    await inspectPr(REF, d)
    await inspectPr({ ...REF } as PrRef, d)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("doesn't cache failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(502, { message: 'Bad Gateway' }))
      .mockResolvedValueOnce(json(200, pull))
    const d = deps(null, fetchImpl as unknown as typeof fetch)
    expect((await inspectPr(REF, d)).ok).toBe(false)
    expect((await inspectPr(REF, d)).ok).toBe(true)
  })
})

describe('inspectIssue', () => {
  const ISSUE = parseIssueUrl('https://github.com/acme/widgets/issues/12')!

  it('returns the cleaned title and body', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { title: 'Login loses redirect', body: 'Steps:\r\n1. …', state: 'open' })
    )
    const res = await inspectIssue(ISSUE, deps(null, fetchImpl as unknown as typeof fetch))
    expect(res).toEqual({
      ok: true,
      issue: {
        url: ISSUE.url,
        number: 12,
        title: 'Login loses redirect',
        body: 'Steps:\n1. …',
        bodyTruncated: false,
        state: 'open'
      }
    })
  })

  it('refuses a pull request posing as an issue', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { title: 'x', body: '', state: 'open', pull_request: {} })
    )
    const res = await inspectIssue(ISSUE, deps(null, fetchImpl as unknown as typeof fetch))
    expect(res).toMatchObject({ ok: false, error: '#12 is a pull request, not an issue.' })
  })
})
