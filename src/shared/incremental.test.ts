import { describe, expect, it } from 'vitest'
import type { Finding } from './findings'
import {
  compareFindings,
  currentLifecycle,
  defaultPostSelection,
  effectiveStatus,
  lifecycleCounts,
  mapLocation,
  offerReason,
  overrideChoices,
  parseUnifiedDiff,
  postedLineage,
  similarity,
  chooseParent,
  type CompareInput
} from './incremental'

const f = (id: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  severity: 'should_fix',
  title: `Finding ${id}`,
  body: '',
  ...extra
})

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,0 +3,2 @@ x
+inserted 1
+inserted 2
@@ -10 +12 @@ y
-old ten
+new ten
@@ -20,3 +22,0 @@
-gone
-gone
-gone
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
diff --git a/dead.ts b/dead.ts
deleted file mode 100644
--- a/dead.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git "a/tab\\there.ts" "b/tab\\there.ts"
--- "a/tab\\there.ts"
+++ "b/tab\\there.ts"
@@ -1 +1 @@
-x
+y
diff --git a/added.ts b/added.ts
new file mode 100644
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+new
`

describe('parseUnifiedDiff and mapLocation', () => {
  const diff = parseUnifiedDiff(DIFF)

  it('follows lines through insertions and deletions', () => {
    expect(mapLocation(diff, 'src/a.ts', 1).to).toBe('src/a.ts:1')
    expect(mapLocation(diff, 'src/a.ts', 2).to).toBe('src/a.ts:2')
    expect(mapLocation(diff, 'src/a.ts', 5)).toMatchObject({ kind: 'untouched', to: 'src/a.ts:7' })
    expect(mapLocation(diff, 'src/a.ts', 10)).toMatchObject({ kind: 'changed' })
    expect(mapLocation(diff, 'src/a.ts', 21)).toMatchObject({ kind: 'changed' })
    expect(mapLocation(diff, 'src/a.ts', 30)).toMatchObject({
      kind: 'untouched',
      to: 'src/a.ts:29'
    })
  })

  it('handles renames, deletions, quoted paths, untouched files and missing diffs', () => {
    expect(mapLocation(diff, 'old name.ts', 4)).toEqual({
      kind: 'untouched',
      from: 'old name.ts:4',
      to: 'new name.ts:4'
    })
    expect(mapLocation(diff, 'dead.ts', 1).kind).toBe('deleted')
    expect(mapLocation(diff, 'tab\there.ts', 1).kind).toBe('changed')
    expect(mapLocation(diff, 'other.ts', 7)).toMatchObject({ kind: 'untouched', to: 'other.ts:7' })
    expect(mapLocation(diff, null, 7).kind).toBe('no_location')
    expect(mapLocation(null, 'src/a.ts', 7).kind).toBe('unknown')
    expect(diff.has('added.ts')).toBe(false)
  })
})

describe('similarity', () => {
  it('scores reworded titles of the same issue above unrelated ones', () => {
    const a = { title: 'Timeout is never cleared on unmount', body: '' }
    expect(
      similarity(a, { title: 'Timeout never cleared when unmounting', body: '' })
    ).toBeGreaterThan(0.35)
    expect(similarity(a, { title: 'SQL injection in search', body: '' })).toBe(0)
  })
})

const base = (over: Partial<CompareInput>): CompareInput => ({
  parentId: 'p',
  comparedSha: 'a'.repeat(40),
  previousVerdict: 'request_changes',
  previous: [],
  current: [],
  model: [],
  diff: parseUnifiedDiff(DIFF),
  previousPosted: new Set(),
  ...over
})
const status = (input: CompareInput): Record<string, string> =>
  Object.fromEntries(compareFindings(input).items.map((i) => [i.key, i.status]))

describe('compareFindings decision table', () => {
  it('accepts a resolved claim only when the code at that spot changed', () => {
    const previous = [
      f('changed', { file: 'src/a.ts', line: 10 }),
      f('deleted', { file: 'dead.ts', line: 1 }),
      f('untouched', { file: 'src/a.ts', line: 5 }),
      f('general')
    ]
    const model = previous.map((p) => ({ id: p.id, status: 'resolved' as const }))
    expect(status(base({ previous, model }))).toEqual({
      'prev:changed': 'resolved',
      'prev:deleted': 'resolved',
      'prev:untouched': 'unable_to_verify',
      'prev:general': 'resolved'
    })
    expect(status(base({ previous: [previous[0]], model, diff: null }))).toEqual({
      'prev:changed': 'unable_to_verify'
    })
  })

  it('accepts a linked finding when the text agrees or the line is untouched', () => {
    const previous = [
      f('p1', { title: 'Race on save', file: 'src/a.ts', line: 10 }),
      f('p2', { title: 'Leaks a file handle', file: 'src/a.ts', line: 10 })
    ]
    const current = [
      f('c1', { title: 'Race condition on save', previous_id: 'p1', file: 'src/a.ts', line: 12 }),
      f('c2', { title: 'Totally different', previous_id: 'p2', file: 'src/a.ts', line: 12 })
    ]
    expect(status(base({ previous, current }))).toEqual({
      'prev:p1': 'still_present',
      'prev:p2': 'unable_to_verify'
    })
  })

  it('marks missing or contradictory model answers as unable to verify', () => {
    const previous = [f('p1', { file: 'src/a.ts', line: 5 }), f('p2'), f('p3')]
    const out = compareFindings(
      base({
        previous,
        model: [
          { id: 'p2', status: 'still_present' },
          { id: 'p3', status: 'unable_to_verify' }
        ]
      })
    )
    expect(out.items.map((i) => [i.key, i.status, i.evidence.reason])).toEqual([
      ['prev:p1', 'unable_to_verify', 'The review did not classify it.'],
      [
        'prev:p2',
        'unable_to_verify',
        'The review says it is still present but lists no current finding for it.'
      ],
      ['prev:p3', 'unable_to_verify', 'The review could not verify it.']
    ])
    expect(compareFindings(base({ previous, model: undefined })).modelCompared).toBe(false)
  })

  it('ignores links to unknown ids and links two findings to one previous only once', () => {
    const current = [
      f('c1', { previous_id: 'nope' }),
      f('c2', { previous_id: 'p1', title: 'Finding p1' }),
      f('c3', { previous_id: 'p1', title: 'Something else entirely' })
    ]
    expect(status(base({ previous: [f('p1')], current }))).toEqual({
      'prev:p1': 'still_present',
      'new:c1': 'new',
      'new:c3': 'new'
    })
  })
})

describe('overrides, counts, lifecycle and selection', () => {
  const comparison = compareFindings(
    base({
      previous: [
        f('fixed', { file: 'src/a.ts', line: 10 }),
        f('kept', { file: 'src/a.ts', line: 5, title: 'Keeps a stale cache' }),
        f('unsure', { file: 'src/a.ts', line: 30, title: 'Retry loop has no limit' })
      ],
      current: [
        f('c-kept', {
          previous_id: 'kept',
          title: 'Keeps a stale cache',
          file: 'src/a.ts',
          line: 7
        }),
        f('c-repeat', { title: 'Retry loop has no upper limit', file: 'src/a.ts', line: 29 }),
        f('c-new', { title: 'New problem', severity: 'blocking' }),
        f('c-nit', { title: 'Tiny', severity: 'nit' })
      ],
      model: [{ id: 'fixed', status: 'resolved' }],
      previousPosted: new Set(['kept', 'unsure'])
    })
  )

  it('counts each issue once', () => {
    expect(lifecycleCounts(comparison)).toEqual({
      new: 2,
      still_present: 1,
      resolved: 1,
      unable_to_verify: 2
    })
    // Settling the repeat as still present folds its "new" side into it.
    const settled = { 'prev:unsure': 'still_present' as const }
    expect(lifecycleCounts(comparison, settled)).toEqual({
      new: 2,
      still_present: 2,
      resolved: 1,
      unable_to_verify: 0
    })
  })

  it('settles both sides of an uncertain pair from either side', () => {
    const fromNew = { 'new:c-repeat': 'still_present' as const }
    expect(lifecycleCounts(comparison, fromNew)).toEqual(
      lifecycleCounts(comparison, { 'prev:unsure': 'still_present' })
    )
    // Marking the previous one resolved makes the repeat a new finding.
    expect(lifecycleCounts(comparison, { 'prev:unsure': 'resolved' })).toEqual({
      new: 3,
      still_present: 1,
      resolved: 2,
      unable_to_verify: 0
    })
    // Calling the current one new says nothing about whether the old one was fixed.
    expect(lifecycleCounts(comparison, { 'new:c-repeat': 'new' }).unable_to_verify).toBe(1)
  })

  it('applies overrides only to uncertain items, with the values their side allows', () => {
    const kept = comparison.items.find((i) => i.key === 'prev:kept')!
    const unsure = comparison.items.find((i) => i.key === 'prev:unsure')!
    const repeat = comparison.items.find((i) => i.key === 'new:c-repeat')!
    expect(overrideChoices(kept)).toEqual([])
    expect(effectiveStatus(kept, { 'prev:kept': 'resolved' })).toBe('still_present')
    expect(overrideChoices(unsure)).toEqual(['still_present', 'resolved'])
    expect(overrideChoices(repeat)).toEqual(['new', 'still_present'])
    expect(effectiveStatus(repeat, { 'new:c-repeat': 'resolved' })).toBe('unable_to_verify')
  })

  it('selects only new, unposted, non-nit findings by default', () => {
    const findings = [
      f('c-kept'),
      f('c-repeat'),
      f('c-new', { severity: 'blocking' }),
      f('c-nit', { severity: 'nit' })
    ]
    const lifecycle = currentLifecycle(comparison)
    expect(lifecycle.get('c-kept')).toEqual({ status: 'still_present', previouslyPosted: true })
    expect([...defaultPostSelection(findings, new Set(), lifecycle)]).toEqual(['c-new'])
    expect([...defaultPostSelection(findings, new Set(['c-new']), lifecycle)]).toEqual([])
    // Full reviews keep the old rule.
    expect([...defaultPostSelection(findings, new Set(), null)]).toEqual([
      'c-kept',
      'c-repeat',
      'c-new'
    ])
    // A repeat settled as still present carries the earlier post.
    expect(
      currentLifecycle(comparison, { 'new:c-repeat': 'still_present' }).get('c-repeat')
    ).toEqual({ status: 'still_present', previouslyPosted: true })
  })

  it('carries posted ids along the lineage', () => {
    expect([...postedLineage([{ findingIds: ['c-new'] }], comparison)].sort()).toEqual([
      'c-kept',
      'c-new'
    ])
    expect([...postedLineage(undefined, null)]).toEqual([])
  })
})

describe('offers', () => {
  const sha = (c: string): string => c.repeat(40)
  const parent = {
    id: 'r1',
    prUrl: 'https://github.com/a/b/pull/1',
    startedAt: 10,
    status: 'done' as const,
    headSha: sha('a'),
    verdict: 'approve'
  }

  it('offers only when GitHub says the PR moved ahead', () => {
    expect(offerReason(parent, sha('b'), 'ahead')).toBeNull()
    expect(offerReason(parent, sha('b'), 'diverged')).toBe('diverged')
    expect(offerReason(parent, sha('b'), 'behind')).toBe('diverged')
    expect(offerReason(parent, sha('a'), null)).toBe('same_commit')
    expect(offerReason(parent, sha('b'), 'identical')).toBe('same_commit')
    expect(offerReason(parent, sha('b'), null)).toBe('compare_failed')
    expect(offerReason(parent, null, null)).toBe('unknown_head')
    expect(offerReason({ ...parent, headSha: null }, sha('b'), 'ahead')).toBe('no_commit')
    expect(offerReason({ ...parent, verdict: null }, sha('b'), 'ahead')).toBe('no_findings')
  })

  it('picks the newest finished review of the same PR', () => {
    const entries = [
      parent,
      { ...parent, id: 'r2', startedAt: 30, status: 'error' as const },
      { ...parent, id: 'r3', startedAt: 20, prUrl: 'https://github.com/A/B/pull/1' },
      { ...parent, id: 'other', startedAt: 40, prUrl: 'https://github.com/a/b/pull/2' }
    ]
    expect(chooseParent(entries, parent.prUrl)?.id).toBe('r3')
    expect(chooseParent(entries, parent.prUrl, 'r1')?.id).toBe('r1')
    expect(chooseParent(entries, parent.prUrl, 'other')).toBeNull()
    expect(chooseParent(entries, 'not a url')).toBeNull()
  })
})
