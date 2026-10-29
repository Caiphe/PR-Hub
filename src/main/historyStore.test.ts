import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../shared/history'
import { applyRetention, FILE_VERSION, HistoryStore, parseHistoryFile } from './historyStore'

const fixture = join(__dirname, '../../fixtures/history/v1.json')

const entry = (id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
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
  error: null,
  ...overrides
})

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-hub-history-'))
  file = join(dir, 'history.json')
})

describe('HistoryStore', () => {
  it('starts empty when there is no file', async () => {
    expect(await new HistoryStore(file).list()).toEqual([])
  })

  it('adds entries newest first and persists them', async () => {
    const store = new HistoryStore(file)
    await store.add(entry('a'))
    await store.add(entry('b', { status: 'error', result: null, error: 'boom' }))

    const reloaded = new HistoryStore(file)
    expect((await reloaded.list()).map((s) => [s.id, s.status, s.verdict])).toEqual([
      ['b', 'error', null],
      ['a', 'done', 'approve']
    ])
    expect((await reloaded.get('a'))?.result?.markdown).toBe('## PR review')
    expect(await reloaded.get('missing')).toBeNull()
  })

  it('keeps only the newest entries and reports the trimmed ids', async () => {
    const store = new HistoryStore(file, 3)
    for (const id of ['1', '2', '3']) expect(await store.add(entry(id))).toEqual([])
    expect(await store.add(entry('4'))).toEqual(['1'])
    expect((await new HistoryStore(file, 3).list()).map((s) => s.id)).toEqual(['4', '3', '2'])
  })

  it('defaults to a limit of 50', async () => {
    const store = new HistoryStore(file)
    for (let i = 0; i < 52; i++) await store.add(entry(String(i)))
    expect(await store.list()).toHaveLength(50)
  })

  it('moves a corrupt file aside and starts fresh', async () => {
    await writeFile(file, '{"entries": [ not json')
    const store = new HistoryStore(file)
    expect(await store.list()).toEqual([])
    expect((await readdir(dir)).some((f) => f.startsWith('history.json.corrupt-'))).toBe(true)

    await store.add(entry('a'))
    expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(1)
  })

  it('hides unreadable entries but keeps them in the file', async () => {
    const future = { id: 'future', status: 'archived' }
    await writeFile(file, JSON.stringify({ version: 1, entries: [entry('good'), future] }))
    const store = new HistoryStore(file)
    expect((await store.list()).map((s) => s.id)).toEqual(['good'])

    await store.add(entry('new'))
    const saved = JSON.parse(await readFile(file, 'utf8')).entries
    expect(saved.map((e: { id: string }) => e.id)).toEqual(['new', 'good', 'future'])
    expect(await store.ids()).toEqual(new Set(['new', 'good', 'future']))
  })

  it('updates an entry in place and persists it', async () => {
    const store = new HistoryStore(file)
    await store.add(entry('a'))
    await store.add(entry('b'))
    const record = {
      at: 5,
      url: 'https://github.com/a/b/pull/1#r',
      mode: 'comment' as const,
      findingIds: ['f1']
    }
    const updated = await store.update('a', (e) => ({ ...e, posted: [record] }))
    expect(updated?.posted).toEqual([record])
    expect(await store.update('missing', (e) => e)).toBeNull()

    const reloaded = new HistoryStore(file)
    expect((await reloaded.list()).map((s) => s.id)).toEqual(['b', 'a'])
    expect((await reloaded.get('a'))?.posted).toEqual([record])
  })

  it('serializes concurrent writes', async () => {
    const store = new HistoryStore(file)
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.add(entry(id))))
    const saved = JSON.parse(await readFile(file, 'utf8')).entries.map((e: HistoryEntry) => e.id)
    expect(saved.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('writes the current file version', async () => {
    await new HistoryStore(file).add(entry('a'))
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(FILE_VERSION)
  })
})

describe('HistoryStore migration', () => {
  it('reads every version 1 entry shape unchanged', async () => {
    const original = await readFile(fixture, 'utf8')
    await writeFile(file, original)
    const store = new HistoryStore(file)
    expect((await store.list()).map((s) => s.id)).toEqual([
      'posted-with-submission',
      'posted-before-submission-ids',
      'no-findings-block',
      'failed-before-task-sources'
    ])
    const old = await store.get('failed-before-task-sources')
    expect(old?.input.taskSource).toBeUndefined()
    expect(old?.pinned).toBeUndefined()
    expect((await store.get('posted-before-submission-ids'))?.posted?.[0].submissionId).toBe(
      undefined
    )

    // Rewriting (here: pinning one entry) keeps every other entry exactly as it was.
    await store.setPinned('no-findings-block', true)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    const before = JSON.parse(original).entries
    expect(saved.version).toBe(2)
    expect(saved.entries).toEqual(
      before.map((e: { id: string }) => (e.id === 'no-findings-block' ? { ...e, pinned: true } : e))
    )
  })

  it('reads a file without a version and a bare entries array', () => {
    expect(parseHistoryFile({ entries: [entry('a')] })?.entries.map((e) => e.id)).toEqual(['a'])
    expect(parseHistoryFile([entry('a'), entry('b')])?.entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(parseHistoryFile({ version: 1 })).toBeNull()
    expect(parseHistoryFile('nope')).toBeNull()
    expect(parseHistoryFile(null)).toBeNull()
  })

  it('keeps fields from a newer version when it rewrites the file', async () => {
    const newer = { ...entry('n'), labels: ['team'], lineage: { parent: 'x' } }
    await writeFile(file, JSON.stringify({ version: 9, entries: [newer] }))
    const store = new HistoryStore(file)
    expect(await store.get('n')).not.toHaveProperty('labels')
    await store.setPinned('n', true)
    const saved = JSON.parse(await readFile(file, 'utf8')).entries[0]
    expect(saved).toEqual({ ...newer, pinned: true })
  })

  it('drops an unknown pinned value without losing the entry', () => {
    const parsed = parseHistoryFile([{ ...entry('a'), pinned: 'yes' }])
    expect(parsed?.entries[0].pinned).toBeUndefined()
  })

  it('keeps the first of two entries with the same id and preserves the other', () => {
    const parsed = parseHistoryFile([entry('a'), entry('a', { status: 'error' })])
    expect(parsed?.entries).toHaveLength(1)
    expect(parsed?.entries[0].status).toBe('done')
    expect(parsed?.unreadable).toHaveLength(1)
  })

  it('recovers readable entries around corrupt ones, in order', async () => {
    const entries = [entry('a'), null, 'garbage', { id: 'half' }, entry('b'), 42]
    await writeFile(file, JSON.stringify({ version: 2, entries }))
    const store = new HistoryStore(file)
    expect((await store.list()).map((s) => s.id)).toEqual(['a', 'b'])
    await store.add(entry('c'))
    const saved = JSON.parse(await readFile(file, 'utf8')).entries
    expect(saved).toEqual([entry('c'), entry('a'), entry('b'), null, 'garbage', { id: 'half' }, 42])
  })
})

describe('pinned retention', () => {
  const pinned = (id: string): HistoryEntry => entry(id, { pinned: true })

  it('never trims pinned entries and does not count them', () => {
    const { kept, removed } = applyRetention(
      [entry('5'), pinned('4'), entry('3'), pinned('2'), entry('1')],
      2
    )
    expect(kept.map((e) => e.id)).toEqual(['5', '4', '3', '2'])
    expect(removed).toEqual(['1'])
  })

  it('keeps a pinned entry when new reviews push it past the limit', async () => {
    const store = new HistoryStore(file, 2)
    await store.add(entry('old'))
    await store.setPinned('old', true)
    await store.add(entry('a'))
    expect(await store.add(entry('b'))).toEqual([])
    expect(await store.add(entry('c'))).toEqual(['a'])
    expect((await new HistoryStore(file, 2).list()).map((s) => [s.id, s.pinned])).toEqual([
      ['c', false],
      ['b', false],
      ['old', true]
    ])
  })

  it('unpins without trimming until the next review is saved', async () => {
    const store = new HistoryStore(file, 1)
    await store.add(pinned('p'))
    await store.add(entry('a'))
    const unpinned = await store.setPinned('p', false)
    expect(unpinned).not.toHaveProperty('pinned')
    expect((await store.list()).map((s) => s.id)).toEqual(['a', 'p'])
    expect(await store.add(entry('b'))).toEqual(['a', 'p'])
  })

  it('returns null when pinning a missing entry', async () => {
    expect(await new HistoryStore(file).setPinned('missing', true)).toBeNull()
  })
})

describe('HistoryStore.remove', () => {
  it('removes one entry and keeps the rest, including unreadable ones', async () => {
    const future = { id: 'future', status: 'archived' }
    await writeFile(file, JSON.stringify({ version: 2, entries: [entry('a'), entry('b'), future] }))
    const store = new HistoryStore(file)
    expect(await store.remove('a')).toBe(true)
    expect(await store.remove('a')).toBe(false)
    expect(await store.remove('future')).toBe(false)
    const saved = JSON.parse(await readFile(file, 'utf8')).entries
    expect(saved.map((e: { id: string }) => e.id)).toEqual(['b', 'future'])
  })
})

describe('atomic writes', () => {
  it('leaves the file and the in-memory history unchanged when a write fails', async () => {
    const store = new HistoryStore(file)
    await store.add(entry('a'))
    const before = await readFile(file, 'utf8')
    // A directory where the temp file goes makes the write fail before the rename.
    await mkdir(`${file}.tmp`)
    await expect(store.add(entry('b'))).rejects.toThrow()
    await expect(store.remove('a')).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await store.list()).map((s) => s.id)).toEqual(['a'])
  })
})
