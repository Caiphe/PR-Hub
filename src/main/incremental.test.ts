import { execFileSync } from 'child_process'
import { mkdtemp, readFile, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '../shared/findings'
import type { HistoryEntry } from '../shared/history'
import { compareFindings, mapLocation, parseUnifiedDiff } from '../shared/incremental'
import {
  FALLBACK,
  incrementalRecord,
  parentProblem,
  prepareIncremental,
  readIncrementalOutcome
} from './incremental'

// Real git repositories in a temp folder, laid out like the skill's fetch output: pr/repo with
// branches "base" and "pr". No network.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: tmpdir()
}

let prDir: string
let repo: string
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { env })
    .toString()
    .trim()
const write = (file: string, text: string): Promise<void> =>
  mkdir(join(repo, file, '..'), { recursive: true }).then(() => writeFile(join(repo, file), text))
const commit = async (files: Record<string, string>, message: string): Promise<string> => {
  for (const [file, text] of Object.entries(files)) await write(file, text)
  git('add', '-A')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}
const numbered = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

beforeEach(async () => {
  prDir = await mkdtemp(join(tmpdir(), 'pr-hub-incremental-'))
  repo = join(prDir, 'repo')
  await mkdir(repo)
  git('init', '-q', '-b', 'base')
  await commit({ 'src/app.ts': numbered(20), 'README.md': 'readme\n' }, 'base')
  git('checkout', '-q', '-b', 'pr')
})

describe('prepareIncremental', () => {
  it('writes the changes since the previous review for appended commits', async () => {
    const prev = await commit({ 'src/app.ts': numbered(20).replace('line 5', 'bug 5') }, 'one')
    await commit({ 'src/app.ts': numbered(20).replace('line 5', 'fixed 5') }, 'two')
    const res = await prepareIncremental(prDir, prev, [], env)
    expect(res).toMatchObject({ ok: true, comparedSha: prev, changedFiles: 1 })
    if (!res.ok) return
    expect(res.commits).toMatch(/two$/)
    const diff = await readFile(join(prDir, 'incremental.diff'), 'utf8')
    expect(diff).toContain('-bug 5')
    expect(diff).toContain('+fixed 5')
    expect(await readIncrementalOutcome(prDir)).toMatchObject({
      marker: { mode: 'incremental', comparedSha: prev }
    })
  })

  it('falls back when nothing changed', async () => {
    const prev = await commit({ 'src/app.ts': numbered(21) }, 'one')
    expect(await prepareIncremental(prDir, prev, [], env)).toEqual({
      ok: false,
      reason: FALLBACK.noChanges
    })
  })

  it('falls back when the previous commit is missing (force-pushed away)', async () => {
    await commit({ 'src/app.ts': numbered(21) }, 'one')
    const res = await prepareIncremental(prDir, 'a'.repeat(40), [], env)
    expect(res).toEqual({ ok: false, reason: FALLBACK.missing })
    expect(await readIncrementalOutcome(prDir)).toEqual({
      marker: { mode: 'full', fallbackReason: FALLBACK.missing },
      compactDiff: null
    })
  })

  it('falls back when the PR was rebased and the old commit is no longer an ancestor', async () => {
    const prev = await commit({ 'src/app.ts': numbered(21) }, 'one')
    git('checkout', '-q', 'base')
    await commit({ 'README.md': 'base moved\n' }, 'base 2')
    git('branch', '-q', '-f', 'pr', 'HEAD')
    git('checkout', '-q', 'pr')
    await commit({ 'src/app.ts': numbered(21) }, 'one, rebased')
    expect(await prepareIncremental(prDir, prev, [], env)).toEqual({
      ok: false,
      reason: FALLBACK.notAncestor
    })
  })

  it('refuses anything but a full commit id', async () => {
    for (const bad of ['HEAD', 'abc', '--output=/tmp/x', 'a'.repeat(39)]) {
      expect(await prepareIncremental(prDir, bad, [], env)).toEqual({
        ok: false,
        reason: FALLBACK.badSha
      })
    }
  })

  it('leaves out base-branch changes merged into the PR', async () => {
    const prev = await commit({ 'src/app.ts': numbered(21) }, 'one')
    git('checkout', '-q', 'base')
    await commit({ 'docs/unrelated.md': 'from main\n' }, 'base work')
    git('checkout', '-q', 'pr')
    git('merge', '-q', '--no-edit', 'base')
    await commit({ 'src/app.ts': numbered(22) }, 'two')
    const res = await prepareIncremental(prDir, prev, [], env)
    expect(res.ok).toBe(true)
    const diff = await readFile(join(prDir, 'incremental.diff'), 'utf8')
    expect(diff).toContain('src/app.ts')
    expect(diff).not.toContain('unrelated.md')
  })

  it('records renames so old lines can be followed', async () => {
    const prev = await commit({ 'src/app.ts': numbered(20, 'code') }, 'one')
    git('mv', 'src/app.ts', 'src/main.ts')
    await commit({ 'src/main.ts': 'header\n' + numbered(20, 'code') }, 'rename')
    await prepareIncremental(prDir, prev, [], env)
    const outcome = await readIncrementalOutcome(prDir)
    const diff = parseUnifiedDiff(outcome!.compactDiff!)
    expect(mapLocation(diff, 'src/app.ts', 10)).toEqual({
      kind: 'untouched',
      from: 'src/app.ts:10',
      to: 'src/main.ts:11'
    })
  })
})

const f = (id: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  severity: 'should_fix',
  title: `Finding ${id}`,
  body: '',
  ...extra
})

describe('comparison against a real diff', () => {
  it('classifies persistent, moved, resolved and new findings', async () => {
    const before = numbered(30)
    const prev = await commit({ 'src/app.ts': before }, 'one')
    // Three lines inserted at the top (everything moves down), and line 20 rewritten.
    const after = 'new a\nnew b\nnew c\n' + before.replace('line 20', 'line 20 fixed')
    await commit({ 'src/app.ts': after }, 'two')
    await prepareIncremental(prDir, prev, [], env)
    const diff = parseUnifiedDiff((await readIncrementalOutcome(prDir))!.compactDiff!)

    const previous = [
      f('p1', { title: 'Timeout never cleared', file: 'src/app.ts', line: 10 }),
      f('p2', { title: 'Off by one in loop', file: 'src/app.ts', line: 20 }),
      f('p3', { title: 'Missing error handling for fetch', file: 'src/app.ts', line: 25 })
    ]
    const current = [
      f('c1', { title: 'Timeout never cleared', file: 'src/app.ts', line: 13, previous_id: 'p1' }),
      f('c2', { title: 'Missing error handling for fetch call', file: 'src/app.ts', line: 28 }),
      f('c3', { title: 'Unused import', file: 'src/app.ts', line: 1 })
    ]
    const comparison = compareFindings({
      parentId: 'parent',
      comparedSha: prev,
      previousVerdict: 'request_changes',
      previous,
      current,
      model: [
        { id: 'p1', status: 'still_present', evidence: 'still there' },
        { id: 'p2', status: 'resolved', evidence: 'loop fixed' }
      ],
      diff,
      previousPosted: new Set(['p1'])
    })
    const byKey = Object.fromEntries(comparison.items.map((i) => [i.key, i]))
    expect(byKey['prev:p1']).toMatchObject({
      status: 'still_present',
      currentId: 'c1',
      previousPosted: true,
      evidence: { location: { kind: 'untouched', to: 'src/app.ts:13' } }
    })
    expect(byKey['prev:p2']).toMatchObject({
      status: 'resolved',
      evidence: { location: { kind: 'changed' } }
    })
    // Not classified by the model, but a near-identical finding sits at the moved line.
    expect(byKey['prev:p3']).toMatchObject({ status: 'unable_to_verify', suggestedId: 'c2' })
    expect(byKey['new:c2']).toMatchObject({ status: 'unable_to_verify', suggestedId: 'p3' })
    expect(byKey['new:c3']).toMatchObject({ status: 'new' })
  })
})

describe('parentProblem and incrementalRecord', () => {
  const parent: HistoryEntry = {
    id: 'parent',
    input: { title: 'T', prUrl: 'https://github.com/a/b/pull/1', description: 'D' },
    startedAt: 1,
    endedAt: 2,
    status: 'done',
    result: {
      markdown: '',
      findings: {
        verdict: 'request_changes',
        summary: '',
        requirements: [],
        findings: [f('p1', { file: 'x.ts', line: 3 })]
      },
      costUsd: null,
      durationMs: 1,
      deniedTools: []
    },
    error: null,
    headSha: 'b'.repeat(40),
    posted: [{ at: 1, url: 'u', mode: 'comment', findingIds: ['p1'] }]
  }

  it('accepts a finished review of the same PR with a commit and findings', () => {
    expect(parentProblem(parent, 'https://github.com/A/B/pull/1/files')).toBeNull()
    expect(parentProblem(null, parent.input.prUrl)).toMatch(/no longer in history/)
    expect(parentProblem(parent, 'https://github.com/a/b/pull/2')).toMatch(/different PR/)
    expect(parentProblem({ ...parent, headSha: undefined }, parent.input.prUrl)).toMatch(/commit/)
    expect(parentProblem({ ...parent, result: null }, parent.input.prUrl)).toMatch(/findings/)
    expect(parentProblem({ ...parent, status: 'error' }, parent.input.prUrl)).toMatch(/history/)
  })

  it('records a fallback, an incremental comparison, or nothing when the run stopped early', () => {
    const base = { parent, parentId: 'parent', findings: null }
    expect(incrementalRecord({ ...base, preset: 'gone', outcome: null })?.fields).toEqual({
      fallbackReason: 'gone'
    })
    expect(incrementalRecord({ ...base, preset: null, outcome: null })).toBeNull()
    expect(
      incrementalRecord({
        ...base,
        preset: null,
        outcome: { marker: { mode: 'full', fallbackReason: 'rebased' }, compactDiff: null }
      })?.outcome
    ).toEqual({
      parentId: 'parent',
      comparedSha: null,
      comparison: null,
      fallbackReason: 'rebased'
    })

    const rec = incrementalRecord({
      ...base,
      preset: null,
      outcome: { marker: { mode: 'incremental', comparedSha: 'b'.repeat(40) }, compactDiff: '' },
      findings: {
        verdict: 'approve',
        summary: '',
        requirements: [],
        findings: [f('c1', { file: 'x.ts', line: 3, previous_id: 'p1', title: 'Finding p1' })],
        previous_findings: [{ id: 'p1', status: 'still_present', evidence: null }]
      }
    })
    expect(rec?.fields.incremental?.comparedSha).toBe('b'.repeat(40))
    expect(rec?.fields.incremental?.comparison?.items[0]).toMatchObject({
      key: 'prev:p1',
      status: 'still_present',
      currentId: 'c1',
      previousPosted: true
    })
    expect(rec?.fields.incremental?.comparison?.modelCompared).toBe(true)
  })
})
