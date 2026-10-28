import { mkdtemp, readdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../shared/history'
import { HistoryStore } from './historyStore'

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

  it('drops individual invalid entries but keeps the rest', async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, entries: [entry('good'), { id: 'bad', status: 'weird' }] })
    )
    expect((await new HistoryStore(file).list()).map((s) => s.id)).toEqual(['good'])
  })

  it('serializes concurrent writes', async () => {
    const store = new HistoryStore(file)
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.add(entry(id))))
    const saved = JSON.parse(await readFile(file, 'utf8')).entries.map((e: HistoryEntry) => e.id)
    expect(saved.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
