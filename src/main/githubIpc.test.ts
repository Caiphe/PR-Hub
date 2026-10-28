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
  ghAccount: vi.fn(async () => 'reviewer')
}))
vi.mock('./githubPoster', async (orig) => ({
  ...(await orig<typeof import('./githubPoster')>()),
  resolveGh: async () => '/fake/gh',
  ghAccount: gh.ghAccount,
  fetchPrState: gh.fetchPrState,
  submitReview: gh.submitReview
}))

const store = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
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
    expect(await preview()).toEqual({ ok: false, error: 'GitHub: HTTP 503', needsAuth: false })
  })
})

describe('github post', () => {
  it('submits each preview at most once', async () => {
    const res = await preview()
    if (!res.ok) throw new Error('preview failed')
    expect((await post(res.preview.previewId)).ok).toBe(true)
    expect((await post(res.preview.previewId)).ok).toBe(false)
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

  it('reports success when GitHub accepted the post even if recording it fails', async () => {
    store.update.mockRejectedValueOnce(new Error('disk full'))
    const res = await preview()
    if (!res.ok) throw new Error('preview failed')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const posted = await post(res.preview.previewId)
    expect(posted).toMatchObject({ ok: true, record: { findingIds: ['f1'], mode: 'comment' } })
  })
})
