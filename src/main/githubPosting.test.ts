import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostPreview, PostResult, PreviewResult } from '../shared/github'
import type { HistoryEntry } from '../shared/history'

// End-to-end posting against a stand-in `gh` that keeps the PR's reviews in a JSON file. The
// real githubIpc, githubPoster, githubReview and HistoryStore run; only Electron's IPC
// registration and the environment lookup are stubbed. Nothing reaches GitHub.
//
// The fake's POST outcome comes from a queue (one line per POST), so tests can script things
// like "time out, then succeed". It can also "accept" a review and then hang, which is exactly
// the case where a naive retry would create a duplicate.

const handlers: Record<string, (...args: unknown[]) => unknown> = {}
vi.mock('./ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => (handlers[channel] = fn)
}))

const ctx = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, history: null as unknown }))
vi.mock('./reviewIpc', () => ({
  getEnvironment: async () => ({ env: ctx.env }),
  getHistory: () => ctx.history
}))
vi.mock('./environment', async (orig) => ({
  ...(await orig<typeof import('./environment')>()),
  resolveChildEnv: async () => ctx.env
}))

import { IPC } from '../shared/ipc'
import { addPostRecord, registerGithubIpc } from './githubIpc'
import { GH_TIMEOUTS } from './githubPoster'
import { HistoryStore } from './historyStore'
registerGithubIpc()

const HEAD = 'a'.repeat(40)
const NEW_HEAD = 'b'.repeat(40)
const PR = 'https://github.com/sindresorhus/slugify/pull/75'

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const dir = process.env.FAKE_GH_DIR
const a = process.argv.slice(2)
const file = (n, d) => { try { return fs.readFileSync(path.join(dir, n), 'utf8').trim() } catch { return d } }
const out = (s) => process.stdout.write(s)
const fail = (stderr, body) => { if (body) out(JSON.stringify(body)); process.stderr.write(stderr + '\\n'); process.exit(1) }
const reviews = () => JSON.parse(file('reviews.json', '[]'))
fs.appendFileSync(path.join(dir, 'calls.log'), a.join(' ') + '\\n')

if (a[0] === 'auth') {
  out('github.com\\n  ✓ Logged in to github.com account reviewer (keyring)\\n  - Active account: true\\n  - Token: gho_****\\n')
} else if (a[0] === 'api') {
  const p = a.find((x) => x.startsWith('repos/') || x === 'user')
  if (p === 'user') out('reviewer\\n')
  else if (a.includes('POST')) {
    const body = JSON.parse(fs.readFileSync(0, 'utf8'))
    fs.appendFileSync(path.join(dir, 'posts.log'), JSON.stringify(body) + '\\n')
    const queue = file('post-queue', 'ok').split('\\n')
    const step = queue.shift() || 'ok'
    fs.writeFileSync(path.join(dir, 'post-queue'), queue.join('\\n'))
    const accept = () => {
      const list = reviews()
      const review = { id: list.length + 1, html_url: '${PR}#pullrequestreview-' + (list.length + 1), body: body.body }
      fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([...list, review]))
      return review
    }
    const hang = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000)
    switch (step) {
      case 'ok': out(JSON.stringify(accept())); break
      case '401': fail('gh: Bad credentials (HTTP 401)', { message: 'Bad credentials' })
      case '403': fail('gh: Resource not accessible by personal access token (HTTP 403)', { message: 'Resource not accessible by personal access token' })
      case '404': fail('gh: Not Found (HTTP 404)', { message: 'Not Found' })
      case '422-stale': fail('gh: Unprocessable Entity (HTTP 422)', { message: 'Unprocessable Entity', errors: ['Pull request review thread line must be part of the diff'] })
      case 'rate': fail('gh: API rate limit exceeded for user ID 1. (HTTP 403)')
      case 'refused': fail('Post "https://api.github.com/repos": dial tcp 140.82.112.6:443: connect: connection refused')
      case 'timeout-before': hang(); accept(); break
      case 'timeout-after': accept(); hang(); break
      case '502-accepted': accept(); fail('gh: HTTP 502: Bad Gateway')
    }
  } else if (p.endsWith('/reviews')) {
    if (file('list', 'ok') === 'fail') fail('error connecting to api.github.com')
    for (const r of reviews()) out(JSON.stringify({ html_url: r.html_url, body: r.body }) + '\\n')
  } else if (p.endsWith('/files')) {
    for (const f of JSON.parse(fs.readFileSync(process.env.FAKE_GH_FILES, 'utf8'))) out(JSON.stringify({ filename: f.filename, patch: f.patch }) + '\\n')
  } else if (p.includes('/compare/')) {
    const compare = file('compare', '404')
    if (compare === '404') fail('gh: Not Found (HTTP 404)')
    out(compare)
  } else if (/pulls\\/\\d+$/.test(p)) {
    out(JSON.stringify({ sha: file('head', '${HEAD}'), author: file('author', 'contributor') }))
  }
}
`

let dir: string
let store: HistoryStore

const entry: HistoryEntry = {
  id: 'r1',
  input: { title: 'T', prUrl: PR, description: 'D' },
  startedAt: 1,
  endedAt: 2,
  status: 'done',
  headSha: HEAD,
  error: null,
  result: {
    markdown: '## Review',
    findings: {
      verdict: 'request_changes',
      summary: 'S',
      requirements: [],
      findings: [
        { id: 'f1', severity: 'blocking', title: 'Bug', file: 'index.js', line: 110, body: 'B' },
        { id: 'f2', severity: 'should_fix', title: 'Docs', body: 'Not tied to a line' }
      ]
    },
    costUsd: 0.1,
    durationMs: 1,
    deniedTools: []
  }
}

const set = (name: string, value: string): Promise<void> => writeFile(join(dir, name), value)
const reviewsOnGitHub = async (): Promise<Array<{ body: string }>> =>
  JSON.parse(await readFile(join(dir, 'reviews.json'), 'utf8').catch(() => '[]'))
const postAttempts = async (): Promise<Array<{ body: string; event: string }>> =>
  (await readFile(join(dir, 'posts.log'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const preview = async (mode = 'comment', ids = ['f1', 'f2']): Promise<PostPreview> => {
  const res = (await handlers[IPC.previewPost]({}, 'r1', ids, mode)) as PreviewResult
  if (!res.ok) throw new Error(`preview failed: ${res.error}`)
  return res.preview
}
const post = (id: string, options?: unknown, ...extra: unknown[]): Promise<PostResult> =>
  handlers[IPC.post]({}, id, options, ...extra) as Promise<PostResult>
const verify = (id: string): Promise<PostResult> =>
  handlers[IPC.verifyPost]({}, id) as Promise<PostResult>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prhub-posting-'))
  await writeFile(join(dir, 'gh'), FAKE_GH)
  await chmod(join(dir, 'gh'), 0o755)
  process.env.PR_HUB_GH = join(dir, 'gh')
  GH_TIMEOUTS.postMs = 2500
  ctx.env = {
    PATH: process.env.PATH,
    FAKE_GH_DIR: dir,
    FAKE_GH_FILES: join(__dirname, '../../fixtures/github/files-75.json')
  }
})
afterAll(async () => {
  delete process.env.PR_HUB_GH
  GH_TIMEOUTS.postMs = 60_000
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  for (const f of [
    'reviews.json',
    'posts.log',
    'post-queue',
    'list',
    'compare',
    'head',
    'author'
  ]) {
    await rm(join(dir, f), { force: true })
  }
  await rm(join(dir, 'history.json'), { force: true })
  store = new HistoryStore(join(dir, 'history.json'))
  await store.add(entry)
  ctx.history = store
})

const recorded = async (): Promise<NonNullable<HistoryEntry['posted']>> =>
  (await store.get('r1'))?.posted ?? []

describe('posting: success and the exact payload', () => {
  it('posts exactly the previewed body (with its marker) once, and records it once', async () => {
    const p = await preview()
    expect(p).toMatchObject({
      repo: 'sindresorhus/slugify',
      reviewedSha: HEAD,
      postingSha: HEAD,
      ownPr: false
    })
    expect(p.body).toContain(`<!-- pr-hub-submission:${p.submissionId} -->`)

    const res = await post(p.previewId)
    expect(res).toMatchObject({
      ok: true,
      record: { submissionId: p.submissionId, findingIds: ['f1', 'f2'] }
    })
    const [sent] = await postAttempts()
    expect(sent.body).toBe(p.body)
    expect(sent.event).toBe('COMMENT')

    // Posting the same confirmed preview again never sends a second review.
    expect(await post(p.previewId)).toMatchObject({ ok: true })
    expect(await reviewsOnGitHub()).toHaveLength(1)
    expect(await postAttempts()).toHaveLength(1)
    expect(await recorded()).toHaveLength(1)
  })

  it('ignores anything the renderer sends besides the preview id', async () => {
    const p = await preview()
    await post(
      p.previewId,
      { force: false, body: 'evil', payload: { body: 'evil' } },
      { body: 'evil' }
    )
    const [sent] = await postAttempts()
    expect(sent.body).toBe(p.body)
    expect(JSON.stringify(sent)).not.toContain('evil')
  })

  it('turns a double click into one review', async () => {
    const p = await preview()
    const [a, b] = await Promise.all([post(p.previewId), post(p.previewId)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ failure: 'busy' })
    expect(await reviewsOnGitHub()).toHaveLength(1)
  })
})

describe('posting: deterministic failures keep the preview usable', () => {
  it.each([
    ['401', 'needs_auth', 'invalid_login'],
    ['403', 'needs_auth', 'pull_requests_permission'],
    ['404', 'needs_auth', 'not_found'],
    ['rate', 'retryable', 'rate_limited'],
    ['refused', 'retryable', 'network']
  ])(
    '%s: nothing accepted, the same preview can be posted after fixing it',
    async (step, failure, kind) => {
      await set('post-queue', `${step}\nok`)
      const p = await preview()
      const res = await post(p.previewId)
      expect(res).toMatchObject({ ok: false, failure, problem: { kind } })
      expect(await reviewsOnGitHub()).toHaveLength(0)

      const retry = await post(p.previewId)
      expect(retry.ok).toBe(true)
      const attempts = await postAttempts()
      expect(attempts).toHaveLength(2)
      expect(attempts[1].body).toBe(attempts[0].body)
      expect(await reviewsOnGitHub()).toHaveLength(1)
    }
  )

  it('422 stale positions: needs a fresh preview and refuses the old one', async () => {
    await set('post-queue', '422-stale')
    const p = await preview()
    expect(await post(p.previewId)).toMatchObject({
      ok: false,
      failure: 'needs_new_preview',
      problem: { kind: 'stale_position' }
    })
    expect(await post(p.previewId)).toMatchObject({ ok: false, failure: 'needs_new_preview' })
    expect(await postAttempts()).toHaveLength(1)
  })
})

describe('posting: unclear outcomes never create duplicates', () => {
  it('timeout after GitHub accepted: finds the review by its marker and records it once', async () => {
    await set('post-queue', 'timeout-after')
    const p = await preview()
    const res = await post(p.previewId)
    expect(res).toMatchObject({
      ok: true,
      recovered: true,
      record: { submissionId: p.submissionId }
    })
    expect(await reviewsOnGitHub()).toHaveLength(1)
    expect(await recorded()).toHaveLength(1)

    // Clicking post again changes nothing.
    expect(await post(p.previewId)).toMatchObject({ ok: true })
    expect(await postAttempts()).toHaveLength(1)
    expect(await recorded()).toHaveLength(1)
  })

  it('a 5xx after acceptance is recovered the same way', async () => {
    await set('post-queue', '502-accepted')
    const p = await preview()
    expect(await post(p.previewId)).toMatchObject({ ok: true, recovered: true })
    expect(await reviewsOnGitHub()).toHaveLength(1)
  })

  it('timeout before acceptance: reports it, waits for the user, and posts once on request', async () => {
    await set('post-queue', 'timeout-before\nok')
    const p = await preview()
    const res = await post(p.previewId)
    expect(res).toMatchObject({ ok: false, failure: 'ambiguous', checked: 'not_found' })
    expect(await reviewsOnGitHub()).toHaveLength(0)
    expect(await postAttempts()).toHaveLength(1) // no automatic retry

    expect(await verify(p.previewId)).toMatchObject({ ok: false, checked: 'not_found' })
    expect(await postAttempts()).toHaveLength(1) // checking never posts

    expect(await post(p.previewId)).toMatchObject({ ok: true })
    expect(await reviewsOnGitHub()).toHaveLength(1)
  })

  it("doesn't send again while it can't check, unless the user forces it", async () => {
    await set('post-queue', 'timeout-before\nok')
    await set('list', 'fail')
    const p = await preview()
    expect(await post(p.previewId)).toMatchObject({
      failure: 'ambiguous',
      checked: 'lookup_failed'
    })
    expect(await post(p.previewId)).toMatchObject({
      failure: 'ambiguous',
      checked: 'lookup_failed'
    })
    expect(await postAttempts()).toHaveLength(1)

    expect(await post(p.previewId, { force: true })).toMatchObject({ ok: true })
    expect(await postAttempts()).toHaveLength(2)
  })

  it('a late-arriving review is found on the next attempt instead of duplicated', async () => {
    await set('post-queue', 'timeout-before')
    const p = await preview()
    expect(await post(p.previewId)).toMatchObject({ checked: 'not_found' })
    // The first request lands after all (GitHub was just slow).
    await set('reviews.json', JSON.stringify([{ id: 1, html_url: `${PR}#r-1`, body: p.body }]))
    expect(await post(p.previewId)).toMatchObject({ ok: true, recovered: true })
    expect(await postAttempts()).toHaveLength(1)
    expect(await recorded()).toHaveLength(1)
  })
})

describe('preview: head changes and own PRs', () => {
  it('keeps findings in unchanged files on their lines after new commits', async () => {
    await set('head', NEW_HEAD)
    await set('compare', JSON.stringify(['readme.md']))
    const p = await preview()
    expect(p.postingSha).toBe(NEW_HEAD)
    expect(p.comments.map((c) => c.findingId)).toEqual(['f1'])
    expect(p.warnings.join(' ')).toMatch(/none of them touch the files/)
  })

  it('moves findings in changed files to the body and says which', async () => {
    await set('head', NEW_HEAD)
    await set('compare', JSON.stringify(['index.js']))
    const p = await preview()
    expect(p.comments).toEqual([])
    expect(p.inBody.find((b) => b.findingId === 'f1')).toMatchObject({
      movedByChange: true,
      reason: expect.stringMatching(/index\.js changed since the review/)
    })
    expect(p.inBody.find((b) => b.findingId === 'f2')?.movedByChange).toBeUndefined()
    expect(p.warnings.join(' ')).toMatch(/1 finding\(s\) in files that changed/)
  })

  it('puts everything in the body when the change set is unknown (force-push)', async () => {
    await set('head', NEW_HEAD)
    const p = await preview()
    expect(p.comments).toEqual([])
    expect(p.warnings.join(' ')).toMatch(/force-push/)
  })

  it('blocks Request changes on your own PR and allows Comment', async () => {
    await set('author', 'Reviewer')
    const blocked = await preview('request_changes')
    expect(blocked.ownPr).toBe(true)
    expect(await post(blocked.previewId)).toMatchObject({
      ok: false,
      failure: 'needs_new_preview',
      problem: { kind: 'own_pr_request_changes' }
    })
    expect(await postAttempts()).toHaveLength(0)

    const comment = await preview('comment')
    expect(await post(comment.previewId)).toMatchObject({ ok: true })
    expect((await postAttempts())[0].event).toBe('COMMENT')
  })
})

describe('addPostRecord', () => {
  it('records each submission once and keeps older records without ids', () => {
    const record = {
      at: 1,
      url: 'u',
      mode: 'comment' as const,
      findingIds: ['f1'],
      submissionId: 's1'
    }
    const legacy = { at: 0, url: 'old', mode: 'comment' as const, findingIds: ['f2'] }
    const once = addPostRecord({ ...entry, posted: [legacy] }, record)
    expect(addPostRecord(once, record).posted).toEqual([legacy, record])
    expect(addPostRecord(addPostRecord(entry, legacy), legacy).posted).toHaveLength(2)
  })
})
