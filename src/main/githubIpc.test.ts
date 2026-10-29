import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../shared/history'
import type { PostResult, PreviewResult } from '../shared/github'

// Handlers are captured from the IPC guard; gh, history and the environment are stubbed.
const handlers: Record<string, (...args: unknown[]) => unknown> = {}
vi.mock('./ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => (handlers[channel] = fn)
}))

const files = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/github/files-75.json'), 'utf8')
)
const HEAD = 'a'.repeat(40)
const gh = vi.hoisted(() => ({
  fetchPrState: vi.fn(),
  submitReview: vi.fn(),
  ghAccount: vi.fn(async (): Promise<{ login: string; tokenKind?: string }> => ({
    login: 'reviewer'
  })),
  checkConnection: vi.fn()
}))
vi.mock('./githubPoster', async (orig) => ({
  ...(await orig<typeof import('./githubPoster')>()),
  resolveGh: async () => '/fake/gh',
  findGh: async () => '/fake/gh',
  ghAccount: gh.ghAccount,
  fetchPrState: gh.fetchPrState,
  submitReview: gh.submitReview
}))

vi.mock('./githubHealth', () => ({ checkConnection: gh.checkConnection }))
vi.mock('./environment', () => ({ resolveChildEnv: async () => ({}) }))

const store = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), list: vi.fn() }))
const inspect = vi.hoisted(() => ({ inspectPr: vi.fn(), compareCommits: vi.fn() }))
vi.mock('./prInspect', () => ({
  inspectPr: inspect.inspectPr,
  inspectIssue: vi.fn(),
  compareCommits: inspect.compareCommits
}))
vi.mock('./reviewIpc', () => ({
  getEnvironment: async () => ({ env: {} }),
  getHistory: () => store
}))

import { IPC } from '../shared/ipc'
import { GhError } from './githubPoster'
import { registerGithubIpc } from './githubIpc'
registerGithubIpc()

const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'r1',
  input: { title: 'T', prUrl: 'https://github.com/sindresorhus/slugify/pull/75', description: 'D' },
  startedAt: 1,
  endedAt: 2,
  status: 'done',
  result: {
    markdown: '## PR review',
    findings: {
      verdict: 'request_changes',
      summary: 'S',
      requirements: [],
      findings: [
        { id: 'f1', severity: 'blocking', title: 'Bug', file: 'index.js', line: 110, body: 'B' }
      ]
    },
    costUsd: 0.1,
    durationMs: 1,
    deniedTools: []
  },
  error: null,
  headSha: HEAD,
  ...overrides
})

const preview = (ids = ['f1'], mode = 'comment'): Promise<PreviewResult> =>
  handlers[IPC.previewPost]({}, 'r1', ids, mode) as Promise<PreviewResult>
const post = (id: string): Promise<PostResult> => handlers[IPC.post]({}, id) as Promise<PostResult>

beforeEach(() => {
  vi.clearAllMocks()
  store.get.mockResolvedValue(entry())
  store.update.mockResolvedValue(entry())
  gh.fetchPrState.mockResolvedValue({ headSha: HEAD, files })
  gh.submitReview.mockResolvedValue('https://github.com/x/y/pull/75#pullrequestreview-1')
})
afterEach(() => vi.useRealTimers())

describe('github preview', () => {
  it('posts inline when the PR is still at the reviewed commit', async () => {
    const res = await preview()
    expect(res.ok && res.preview.comments.map((c) => c.line)).toEqual([110])
    expect(res.ok && res.preview.warnings).toEqual([])
  })

  it('moves everything to the body when the PR has new commits', async () => {
    gh.fetchPrState.mockResolvedValue({ headSha: 'b'.repeat(40), files })
    const res = await preview()
    expect(res.ok && res.preview.comments).toEqual([])
    expect(res.ok && res.preview.warnings[0]).toMatch(/new commits/)
  })

  it('moves everything to the body when the reviewed commit is unknown', async () => {
    store.get.mockResolvedValue(entry({ headSha: undefined }))
    const res = await preview()
    expect(res.ok && res.preview.comments).toEqual([])
    expect(res.ok && res.preview.warnings[0]).toMatch(/didn't record/)
  })

  it('refuses reviews without findings', async () => {
    store.get.mockResolvedValue(entry({ result: null, status: 'error' }))
    expect(await preview()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no findings/)
    })
  })

  it('surfaces gh failures that are not about auth as themselves', async () => {
    gh.ghAccount.mockRejectedValueOnce(new GhError('GitHub: HTTP 503', false))
    expect(await preview()).toMatchObject({
      ok: false,
      error: 'GitHub: HTTP 503',
      needsAuth: false,
      problem: { kind: 'server_error' }
    })
  })

  it('warns before posting with a fine-grained token', async () => {
    gh.ghAccount.mockResolvedValueOnce({ login: 'reviewer', tokenKind: 'fine_grained_pat' })
    const res = await preview()
    expect(res.ok && res.preview.account).toBe('reviewer')
    expect(res.ok && res.preview.warnings[0]).toMatch(
      /fine-grained token.*sindresorhus\/slugify with Pull requests: Read and write/
    )
  })
})

describe('github preview after an incremental review', () => {
  it('warns when a ticked finding continues one already posted', async () => {
    const item = {
      key: 'prev:p1',
      status: 'still_present' as const,
      previous: { id: 'p1', title: 'Bug', severity: 'blocking' as const, file: null, line: null },
      currentId: 'f1',
      suggestedId: null,
      previousPosted: true,
      evidence: {
        model: null,
        location: { kind: 'no_location' as const, from: null, to: null },
        similarity: 1,
        reason: 'r'
      }
    }
    store.get.mockResolvedValue(
      entry({
        incremental: {
          parentId: 'r0',
          comparedSha: 'c'.repeat(40),
          comparison: {
            parentId: 'r0',
            comparedSha: 'c'.repeat(40),
            previousVerdict: 'request_changes',
            modelCompared: true,
            items: [item]
          }
        }
      })
    )
    const res = await preview()
    expect(res.ok && res.preview.warnings.join(' ')).toMatch(
      /1 selected finding continues one already posted from an earlier review/
    )
  })
})

describe('incremental offer', () => {
  const offer = (url: unknown, parentId?: unknown): Promise<unknown> =>
    handlers[IPC.incrementalOffer]({}, url, parentId) as Promise<unknown>
  const summary = {
    id: 'r1',
    title: 'T',
    prUrl: 'https://github.com/a/b/pull/1',
    startedAt: 5,
    status: 'done',
    headSha: 'a'.repeat(40),
    verdict: 'approve',
    counts: { blocking: 0, should_fix: 1, nit: 0 },
    incremental: null
  }

  it('offers when GitHub says the PR moved ahead of the reviewed commit', async () => {
    store.list.mockResolvedValue([summary])
    inspect.inspectPr.mockResolvedValue({ ok: true, pr: { headSha: 'b'.repeat(40) } })
    inspect.compareCommits.mockResolvedValue('ahead')
    expect(await offer('https://github.com/a/b/pull/1/files')).toMatchObject({
      available: true,
      reason: null,
      headSha: 'b'.repeat(40),
      parent: { id: 'r1', headSha: 'a'.repeat(40) }
    })
    expect(inspect.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'a', repo: 'b', number: 1 }),
      'a'.repeat(40),
      'b'.repeat(40),
      expect.anything()
    )
  })

  it('explains why not after a rebase, with no new commits, or without history', async () => {
    store.list.mockResolvedValue([summary])
    inspect.inspectPr.mockResolvedValue({ ok: true, pr: { headSha: 'b'.repeat(40) } })
    inspect.compareCommits.mockResolvedValue('diverged')
    expect(await offer(summary.prUrl)).toMatchObject({
      available: false,
      reason: 'diverged',
      message: expect.stringMatching(/force-pushed or rebased/)
    })
    inspect.inspectPr.mockResolvedValue({ ok: true, pr: { headSha: 'a'.repeat(40) } })
    expect(await offer(summary.prUrl)).toMatchObject({ available: false, reason: 'same_commit' })
    store.list.mockResolvedValue([])
    expect(await offer(summary.prUrl)).toMatchObject({ available: false, parent: null })
    expect(await offer('https://evil.example/x')).toMatchObject({ parent: null })
  })
})

describe('github post', () => {
  it('submits each preview at most once', async () => {
    const res = await preview()
    if (!res.ok) throw new Error('preview failed')
    const first = await post(res.preview.previewId)
    expect(first.ok).toBe(true)
    // A repeat returns the same record instead of posting again.
    expect(await post(res.preview.previewId)).toEqual(first)
    expect(gh.submitReview).toHaveBeenCalledTimes(1)
  })

  it('rejects an expired preview', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const res = await preview()
    if (!res.ok) throw new Error('preview failed')
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    expect(await post(res.preview.previewId)).toMatchObject({ ok: false })
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  it('explains a fine-grained token 403 on post as a Pull requests permission problem', async () => {
    gh.ghAccount.mockResolvedValueOnce({ login: 'reviewer', tokenKind: 'fine_grained_pat' })
    gh.submitReview.mockRejectedValueOnce(
      new GhError(
        'GitHub: gh: Resource not accessible by personal access token (HTTP 403)',
        false,
        'gh: Resource not accessible by personal access token (HTTP 403)'
      )
    )
    const res = await preview()
    if (!res.ok) throw new Error('preview failed')
    const posted = await post(res.preview.previewId)
    expect(posted).toMatchObject({ ok: false, problem: { kind: 'pull_requests_permission' } })
  })

  it('reports success when GitHub accepted the post even if recording it fails', async () => {
    store.update.mockRejectedValueOnce(new Error('disk full'))
    const res = await preview()
    if (!res.ok) throw new Error('preview failed')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const posted = await post(res.preview.previewId)
    expect(posted).toMatchObject({ ok: true, record: { findingIds: ['f1'], mode: 'comment' } })
  })
})

describe('github status', () => {
  const status = (url: unknown): Promise<unknown> =>
    handlers[IPC.githubStatus]({}, url) as Promise<unknown>

  it('passes on only a canonical, valid PR link', async () => {
    gh.checkConnection.mockResolvedValue({})
    await status('https://github.com/a/b/pull/3/files#diff')
    expect(gh.checkConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ gh: '/fake/gh', prUrl: 'https://github.com/a/b/pull/3' })
    )
    await status('https://evil.example/pull/3')
    expect(gh.checkConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ prUrl: undefined })
    )
    await status({ toString: () => 'x' })
    expect(gh.checkConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ prUrl: undefined })
    )
  })
})
