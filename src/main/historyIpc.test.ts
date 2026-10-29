import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { HistoryEntry } from '../shared/history'
import { HistoryStore } from './historyStore'

// Real history store and folders in a temp dir; Electron's dialogs and the IPC guard are stubbed.
const handlers: Record<string, (...args: unknown[]) => unknown> = {}
vi.mock('./ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => (handlers[channel] = fn)
}))

const ctx = vi.hoisted(() => ({
  store: null as unknown as HistoryStore,
  reviews: '',
  downloads: '',
  showMessageBox: vi.fn(),
  showSaveDialog: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => ctx.downloads },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: ctx.showMessageBox, showSaveDialog: ctx.showSaveDialog }
}))
vi.mock('./reviewIpc', () => ({
  getHistory: () => ctx.store,
  reviewsDir: () => ctx.reviews
}))

const { deleteReview, exportReview, registerHistoryIpc, setOverride, setPinned } =
  await import('./historyIpc')

const sender = {} as WebContents
const entry = (id: string): HistoryEntry => ({
  id,
  input: { title: `Task ${id}`, prUrl: 'https://github.com/a/b/pull/1', description: 'D' },
  startedAt: 1000,
  endedAt: 2000,
  status: 'done',
  result: {
    markdown: '## PR review',
    findings: { verdict: 'approve', summary: '', requirements: [], findings: [] },
    costUsd: 0.5,
    durationMs: 1000,
    deniedTools: []
  },
  error: null
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-hub-history-ipc-'))
  ctx.reviews = join(root, 'reviews')
  ctx.downloads = join(root, 'downloads')
  await mkdir(ctx.downloads, { recursive: true })
  ctx.store = new HistoryStore(join(root, 'history.json'))
  for (const id of ['keep', 'gone']) {
    await ctx.store.add(entry(id))
    await mkdir(join(ctx.reviews, id), { recursive: true })
    await writeFile(join(ctx.reviews, id, 'stream.jsonl'), '{"type":"system"}\n')
  }
  ctx.showMessageBox.mockReset()
  ctx.showSaveDialog.mockReset()
})

describe('deleteReview', () => {
  it('asks first, then removes the entry and its folder only', async () => {
    ctx.showMessageBox.mockResolvedValue({ response: 0 })
    expect(await deleteReview(sender, 'gone')).toBe('deleted')
    expect(ctx.showMessageBox).toHaveBeenCalledOnce()
    expect(ctx.showMessageBox.mock.calls[0][0].detail).toContain('a/b#1')
    expect((await ctx.store.list()).map((s) => s.id)).toEqual(['keep'])
    expect(await readdir(ctx.reviews)).toEqual(['keep'])
    const saved = JSON.parse(await readFile(join(root, 'history.json'), 'utf8')).entries
    expect(saved.map((e: HistoryEntry) => e.id)).toEqual(['keep'])
  })

  it('changes nothing when the user cancels', async () => {
    ctx.showMessageBox.mockResolvedValue({ response: 1 })
    expect(await deleteReview(sender, 'gone')).toBe('cancelled')
    expect((await ctx.store.list()).map((s) => s.id)).toEqual(['gone', 'keep'])
    expect((await readdir(ctx.reviews)).sort()).toEqual(['gone', 'keep'])
  })

  it('refuses ids that could leave the reviews folder, without asking', async () => {
    for (const id of ['../keep', '..', '', 'a/b', 42, null]) {
      expect(await deleteReview(sender, id)).toBe('missing')
    }
    expect(await deleteReview(sender, 'unknown')).toBe('missing')
    expect(ctx.showMessageBox).not.toHaveBeenCalled()
    expect((await readdir(ctx.reviews)).sort()).toEqual(['gone', 'keep'])
  })

  it('still deletes the entry when there is no folder', async () => {
    ctx.showMessageBox.mockResolvedValue({ response: 0 })
    await ctx.store.add(entry('nofolder'))
    expect(await deleteReview(sender, 'nofolder')).toBe('deleted')
    expect(await ctx.store.get('nofolder')).toBeNull()
  })
})

describe('exportReview', () => {
  it('writes the chosen file and returns only its name', async () => {
    const target = join(ctx.downloads, 'out.md')
    ctx.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await exportReview(sender, 'keep', 'markdown')).toEqual({
      status: 'saved',
      fileName: 'out.md'
    })
    const options = ctx.showSaveDialog.mock.calls[0][0]
    expect(options.defaultPath).toBe(join(ctx.downloads, 'pr-hub-a-b-1-1970-01-01.md'))
    expect(options.properties).toContain('showOverwriteConfirmation')
    expect(await readFile(target, 'utf8')).toMatch(/^# Task keep\n/)
  })

  it('writes JSON for the json format', async () => {
    const target = join(ctx.downloads, 'out.json')
    ctx.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    await exportReview(sender, 'keep', 'json')
    expect(JSON.parse(await readFile(target, 'utf8')).review.id).toBe('keep')
  })

  it('writes nothing when the dialog is cancelled', async () => {
    ctx.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await exportReview(sender, 'keep', 'markdown')).toEqual({ status: 'cancelled' })
    expect(await readdir(ctx.downloads)).toEqual([])
  })

  it('reports a write failure without the path', async () => {
    const target = join(ctx.downloads, 'missing-dir', 'out.md')
    ctx.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await exportReview(sender, 'keep', 'markdown')
    expect(res).toEqual({ status: 'failed', error: "Couldn't save the file (ENOENT)." })
  })

  it('fails for a missing review without opening a dialog', async () => {
    expect((await exportReview(sender, 'nope', 'markdown')).status).toBe('failed')
    expect(ctx.showSaveDialog).not.toHaveBeenCalled()
  })
})

describe('setPinned', () => {
  it('pins and unpins, returning the summary', async () => {
    expect((await setPinned('keep', true))?.pinned).toBe(true)
    expect((await setPinned('keep', 'yes'))?.pinned).toBe(false)
    expect(await setPinned('../keep', true)).toBeNull()
    expect(await setPinned('unknown', true)).toBeNull()
  })
})

describe('registerHistoryIpc', () => {
  it('registers the history channels', () => {
    registerHistoryIpc()
    expect(Object.keys(handlers).sort()).toEqual([
      'history:delete',
      'history:export',
      'history:set-override',
      'history:set-pinned'
    ])
  })
})

describe('setOverride', () => {
  const item = (key: string, status: string, previous: boolean): unknown => ({
    key,
    status,
    previous: previous
      ? { id: key.slice(5), title: 'T', severity: 'nit', file: null, line: null }
      : null,
    currentId: previous ? null : key.slice(4),
    suggestedId: null,
    previousPosted: false,
    evidence: {
      model: null,
      location: { kind: 'no_location', from: null, to: null },
      similarity: null,
      reason: 'r'
    }
  })

  beforeEach(async () => {
    await ctx.store.add({
      ...entry('inc'),
      incremental: {
        parentId: 'keep',
        comparedSha: 'c'.repeat(40),
        comparison: {
          parentId: 'keep',
          comparedSha: 'c'.repeat(40),
          previousVerdict: null,
          modelCompared: true,
          items: [
            item('prev:u', 'unable_to_verify', true),
            item('prev:s', 'still_present', true),
            item('new:n', 'unable_to_verify', false)
          ] as never
        }
      }
    })
  })

  it('settles uncertain items with the values their side allows, and clears them', async () => {
    expect((await setOverride('inc', 'prev:u', 'resolved'))?.overrides).toEqual({
      'prev:u': 'resolved'
    })
    expect((await setOverride('inc', 'new:n', 'still_present'))?.overrides).toEqual({
      'prev:u': 'resolved',
      'new:n': 'still_present'
    })
    expect((await setOverride('inc', 'prev:u', null))?.overrides).toEqual({
      'new:n': 'still_present'
    })
    expect((await setOverride('inc', 'new:n', null))?.overrides).toBeUndefined()
  })

  it('ignores settled items, disallowed values, unknown keys and bad ids', async () => {
    expect((await setOverride('inc', 'prev:s', 'resolved'))?.overrides).toBeUndefined()
    expect((await setOverride('inc', 'new:n', 'resolved'))?.overrides).toBeUndefined()
    expect((await setOverride('inc', 'prev:x', 'resolved'))?.overrides).toBeUndefined()
    expect(await setOverride('../inc', 'prev:u', 'resolved')).toBeNull()
    expect(await setOverride('inc', 42, 'resolved')).toBeNull()
    expect(await setOverride('keep', 'prev:u', 'resolved')).not.toHaveProperty('overrides')
  })
})
