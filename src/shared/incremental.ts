import { z } from 'zod'
import { SEVERITIES, type Finding, type PreviousFinding } from './findings'
import { parsePrUrl } from './validate'

// Incremental re-reviews: comparing a new review of a PR with the previous one. Everything here
// is pure so each rule is tested without git or a model. The model's own comparison is one
// input; deterministic evidence (how lines moved between the two commits, how similar the text
// is) decides whether that claim is accepted, and anything that doesn't add up is "Unable to
// verify" for the user to settle locally.

export const LIFECYCLE = ['new', 'still_present', 'resolved', 'unable_to_verify'] as const
export type Lifecycle = (typeof LIFECYCLE)[number]

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  new: 'New',
  still_present: 'Still present',
  resolved: 'Resolved',
  unable_to_verify: 'Unable to verify'
}

const LocationSchema = z.object({
  /** untouched: the line itself wasn't edited (it may have moved). no_location: none to check. */
  kind: z.enum(['untouched', 'changed', 'deleted', 'no_location', 'unknown']),
  from: z.string().nullable(),
  to: z.string().nullable()
})
export type LocationEvidence = z.infer<typeof LocationSchema>

export const ComparisonItemSchema = z.object({
  /** "prev:<id>" for a finding of the previous review, "new:<id>" for one only in this review. */
  key: z.string().min(1),
  status: z.enum(LIFECYCLE),
  previous: z
    .object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(SEVERITIES),
      file: z.string().nullable(),
      line: z.number().nullable()
    })
    .nullable(),
  /** The finding in this review it corresponds to (still present, or a "new" item's own id). */
  currentId: z.string().nullable(),
  /** Uncertain items: the likely counterpart that couldn't be confirmed. */
  suggestedId: z.string().nullable(),
  /** The previous finding (or one it continued) was already posted to GitHub. */
  previousPosted: z.boolean(),
  evidence: z.object({
    model: z.object({ status: z.string(), note: z.string().nullable() }).nullable(),
    location: LocationSchema,
    similarity: z.number().nullable(),
    reason: z.string()
  })
})
export type ComparisonItem = z.infer<typeof ComparisonItemSchema>

export const ComparisonSchema = z.object({
  parentId: z.string(),
  comparedSha: z.string(),
  previousVerdict: z.string().nullable(),
  /** False when the model's comparison block was missing or malformed. */
  modelCompared: z.boolean(),
  items: z.array(ComparisonItemSchema)
})
export type Comparison = z.infer<typeof ComparisonSchema>

/** Local decisions on uncertain items, keyed by item key. Never sent to GitHub. */
export const OverrideSchema = z.enum(['new', 'still_present', 'resolved'])
export type Override = z.infer<typeof OverrideSchema>

// --- Diff between the two reviewed commits ------------------------------------------------

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export interface FileChange {
  oldPath: string
  /** Null when the file was deleted. */
  newPath: string | null
  hunks: Hunk[]
}

/** Changes keyed by the file's path in the previous commit. Files not in it are unchanged. */
export type DiffIndex = Map<string, FileChange>

/** Undoes git's C-style quoting of unusual paths ("a/tab\there"). */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  const bytes: number[] = []
  const body = path.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = body[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
      bytes.push(...new TextEncoder().encode(map[next] ?? next))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const stripPrefix = (path: string): string | null =>
  path === '/dev/null' ? null : unquote(path).replace(/^[ab]\//, '')

/** Parses `git diff -M -U0 <prev> <head>` output. Unknown lines are ignored. */
export function parseUnifiedDiff(text: string): DiffIndex {
  const index: DiffIndex = new Map()
  let current: FileChange | null = null
  let renameFrom: string | null = null
  let renameTo: string | null = null
  let minus: string | null | undefined
  const flush = (): void => {
    if (current) index.set(current.oldPath, current)
    current = null
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      renameFrom = renameTo = null
      minus = undefined
      continue
    }
    if (line.startsWith('rename from ')) renameFrom = unquote(line.slice(12))
    else if (line.startsWith('rename to ')) renameTo = unquote(line.slice(10))
    else if (line.startsWith('--- ')) minus = stripPrefix(line.slice(4))
    else if (line.startsWith('+++ ')) {
      const plus = stripPrefix(line.slice(4))
      const oldPath = minus ?? renameFrom
      // Added files have no previous path, so no previous finding can point into them.
      if (oldPath) current = { oldPath, newPath: plus, hunks: [] }
    } else if (line.startsWith('@@ ') && current) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (m) {
        current.hunks.push({
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4])
        })
      }
    }
    // A pure rename (100% similar) has no ---/+++ lines.
    if (!current && renameFrom && renameTo && line.startsWith('rename to ')) {
      current = { oldPath: renameFrom, newPath: renameTo, hunks: [] }
    }
  }
  flush()
  return index
}

const loc = (file: string, line: number | null): string => (line ? `${file}:${line}` : file)

/** Where a previous finding's line is in the new commit, and whether the line was edited. */
export function mapLocation(
  diff: DiffIndex | null,
  file: string | null | undefined,
  line: number | null | undefined
): LocationEvidence {
  if (!file) return { kind: 'no_location', from: null, to: null }
  const from = loc(file, line ?? null)
  if (!diff) return { kind: 'unknown', from, to: null }
  const change = diff.get(file)
  if (!change) return { kind: 'untouched', from, to: from }
  if (change.newPath === null) return { kind: 'deleted', from, to: null }
  if (!line) {
    // A whole-file finding: the file changed, but there's no line to check.
    return { kind: change.hunks.length ? 'changed' : 'untouched', from, to: change.newPath }
  }
  let shift = 0
  for (const h of [...change.hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    if (h.oldCount === 0) {
      // Pure insertion after old line oldStart.
      if (line > h.oldStart) shift += h.newCount
      continue
    }
    const end = h.oldStart + h.oldCount - 1
    if (line < h.oldStart) break
    if (line <= end) return { kind: 'changed', from, to: loc(change.newPath, h.newStart || null) }
    shift += h.newCount - h.oldCount
  }
  return { kind: 'untouched', from, to: loc(change.newPath, line + shift) }
}

// --- Text similarity -----------------------------------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'not', 'when', 'with', 'this', 'that', 'are', 'was'])

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`*_~>#[\]()]/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2 && !STOP.has(t))
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

/** 0..1, mostly from the titles; bodies count when both have one. */
export function similarity(
  a: Pick<Finding, 'title' | 'body'>,
  b: Pick<Finding, 'title' | 'body'>
): number {
  const title = jaccard(tokens(a.title), tokens(b.title))
  if (!a.body || !b.body) return round(title)
  return round(0.7 * title + 0.3 * jaccard(tokens(a.body), tokens(b.body)))
}

const round = (n: number): number => Math.round(n * 100) / 100

// --- Matching --------------------------------------------------------------------------------

/** Linked findings with at least this much in common are accepted wherever they now are. */
const LINK_SIMILARITY = 0.35
/** An unlinked pair this similar, close by, is probably the same issue. */
const REPEAT_SIMILARITY = 0.5
const REPEAT_LINES = 5

export interface CompareInput {
  parentId: string
  comparedSha: string
  previousVerdict: string | null
  previous: readonly Finding[]
  current: readonly Finding[]
  /** The model's classification; undefined when its block was missing or malformed. */
  model: readonly PreviousFinding[] | undefined
  /** Null when the diff between the commits isn't available. */
  diff: DiffIndex | null
  /** Ids of previous findings that were posted (directly or through their own lineage). */
  previousPosted: ReadonlySet<string>
}

function parsePos(to: string | null): { file: string; line: number | null } | null {
  if (!to) return null
  const m = /^(.*?)(?::(\d+))?$/.exec(to)
  return m ? { file: m[1], line: m[2] ? Number(m[2]) : null } : null
}

function nearby(location: LocationEvidence, f: Finding): boolean {
  const pos = parsePos(location.to)
  if (!pos || !f.file || pos.file !== f.file) return false
  if (pos.line === null || !f.line) return pos.line === null && !f.line
  return Math.abs(pos.line - f.line) <= REPEAT_LINES
}

export function compareFindings(input: CompareInput): Comparison {
  const previousIds = new Set(input.previous.map((p) => p.id))
  const modelById = new Map((input.model ?? []).map((m) => [m.id, m]))
  // The first current finding that names a previous finding is its continuation.
  const linkedTo = new Map<string, Finding>()
  for (const c of input.current) {
    if (c.previous_id && previousIds.has(c.previous_id) && !linkedTo.has(c.previous_id)) {
      linkedTo.set(c.previous_id, c)
    }
  }
  const linkedCurrent = new Set([...linkedTo.values()].map((c) => c.id))
  const unlinked = input.current.filter((c) => !linkedCurrent.has(c.id))
  const claimed = new Set<string>()
  const items: ComparisonItem[] = []

  for (const p of input.previous) {
    const location = mapLocation(input.diff, p.file, p.line)
    const said = modelById.get(p.id)
    const model = said ? { status: said.status, note: said.evidence ?? null } : null
    const linked = linkedTo.get(p.id)
    const base = {
      key: `prev:${p.id}`,
      previous: {
        id: p.id,
        title: p.title,
        severity: p.severity,
        file: p.file ?? null,
        line: p.line ?? null
      },
      previousPosted: input.previousPosted.has(p.id)
    }
    const decide = (
      status: Lifecycle,
      reason: string,
      extra: { currentId?: string | null; suggestedId?: string | null; sim?: number | null } = {}
    ): void => {
      items.push({
        ...base,
        status,
        currentId: extra.currentId ?? null,
        suggestedId: extra.suggestedId ?? null,
        evidence: { model, location, similarity: extra.sim ?? null, reason }
      })
    }

    if (linked) {
      const sim = similarity(p, linked)
      if (
        sim >= LINK_SIMILARITY ||
        location.kind === 'untouched' ||
        location.kind === 'no_location'
      ) {
        decide('still_present', 'Listed again in this review, and the evidence agrees.', {
          currentId: linked.id,
          sim
        })
      } else {
        decide(
          'unable_to_verify',
          'The review linked a current finding to it, but the code there changed and the two read differently.',
          { suggestedId: linked.id, sim }
        )
      }
      continue
    }

    // Not linked: look for an unlinked current finding that is very likely the same issue.
    const repeat = unlinked
      .filter((c) => !claimed.has(c.id))
      .map((c) => ({ c, sim: similarity(p, c) }))
      .filter(({ c, sim }) => sim >= REPEAT_SIMILARITY && (nearby(location, c) || sim >= 0.8))
      .sort((a, b) => b.sim - a.sim)[0]

    if (said?.status === 'resolved') {
      if (location.kind === 'changed' || location.kind === 'deleted') {
        decide('resolved', 'The review says it is fixed, and the code at that spot changed.')
      } else if (location.kind === 'no_location') {
        decide(
          'resolved',
          "The review says it is fixed. It isn't tied to a line, so only the review's comparison supports this."
        )
      } else if (repeat) {
        claimed.add(repeat.c.id)
        decide(
          'unable_to_verify',
          'The review says it is fixed, but a very similar finding is listed again nearby.',
          {
            suggestedId: repeat.c.id,
            sim: repeat.sim
          }
        )
      } else {
        decide(
          'unable_to_verify',
          location.kind === 'unknown'
            ? "The review says it is fixed, but PR Hub couldn't read the changes between the commits to check."
            : "The review says it is fixed, but the code at that spot didn't change."
        )
      }
      continue
    }

    if (repeat) {
      claimed.add(repeat.c.id)
      decide(
        'unable_to_verify',
        'A very similar finding is listed again, but the review did not link them.',
        {
          suggestedId: repeat.c.id,
          sim: repeat.sim
        }
      )
      continue
    }
    decide(
      'unable_to_verify',
      said?.status === 'still_present'
        ? 'The review says it is still present but lists no current finding for it.'
        : said
          ? 'The review could not verify it.'
          : 'The review did not classify it.'
    )
  }

  for (const c of unlinked) {
    if (claimed.has(c.id)) {
      // Shown on the previous finding's uncertain item; also listed here so it can be settled.
      const prev = items.find((i) => i.suggestedId === c.id)
      items.push({
        key: `new:${c.id}`,
        status: 'unable_to_verify',
        previous: null,
        currentId: c.id,
        suggestedId: prev?.previous?.id ?? null,
        previousPosted: false,
        evidence: {
          model: null,
          location: {
            kind: 'no_location',
            from: null,
            to: c.file ? loc(c.file, c.line ?? null) : null
          },
          similarity: prev?.evidence.similarity ?? null,
          reason: 'Possibly the same issue as a finding from the previous review.'
        }
      })
      continue
    }
    items.push({
      key: `new:${c.id}`,
      status: 'new',
      previous: null,
      currentId: c.id,
      suggestedId: null,
      previousPosted: false,
      evidence: {
        model: null,
        location: {
          kind: 'no_location',
          from: null,
          to: c.file ? loc(c.file, c.line ?? null) : null
        },
        similarity: null,
        reason: 'Not in the previous review.'
      }
    })
  }

  return {
    parentId: input.parentId,
    comparedSha: input.comparedSha,
    previousVerdict: input.previousVerdict,
    modelCompared: input.model !== undefined,
    items
  }
}

// --- Effective state, counts, selection ------------------------------------------------------

/** Overrides apply only to uncertain items and only to the values their side allows. */
export function overrideChoices(item: ComparisonItem): Override[] {
  if (item.status !== 'unable_to_verify') return []
  return item.previous ? ['still_present', 'resolved'] : ['new', 'still_present']
}

export function effectiveStatus(
  item: ComparisonItem,
  overrides: Readonly<Record<string, Override>> = {}
): Lifecycle {
  const o = overrides[item.key]
  return o && overrideChoices(item).includes(o) ? o : item.status
}

/**
 * An uncertain pair (a previous finding and the current one that may repeat it) is one
 * question: settling either side settles the other, unless the user set both.
 */
export function expandOverrides(
  comparison: Comparison,
  overrides: Readonly<Record<string, Override>> = {}
): Record<string, Override> {
  const out: Record<string, Override> = {}
  const byKey = new Map(comparison.items.map((i) => [i.key, i]))
  for (const [key, value] of Object.entries(overrides)) {
    const item = byKey.get(key)
    if (item && overrideChoices(item).includes(value)) out[key] = value
  }
  for (const item of comparison.items) {
    if (!item.suggestedId || item.status !== 'unable_to_verify') continue
    const set = out[item.key]
    if (!set || !(item.key in overrides)) continue
    const other = byKey.get(item.previous ? `new:${item.suggestedId}` : `prev:${item.suggestedId}`)
    if (!other || other.status !== 'unable_to_verify' || other.key in overrides) continue
    if (item.previous) out[other.key] = set === 'still_present' ? 'still_present' : 'new'
    else if (set === 'still_present') out[other.key] = 'still_present'
  }
  return out
}

/**
 * Counts per lifecycle. A "new" item that was confirmed as a repeat of a previous finding, and
 * the previous finding it repeats, describe one issue: it is counted once, on the previous side.
 */
export function lifecycleCounts(
  comparison: Comparison,
  overrides: Readonly<Record<string, Override>> = {}
): Record<Lifecycle, number> {
  overrides = expandOverrides(comparison, overrides)
  const counts: Record<Lifecycle, number> = {
    new: 0,
    still_present: 0,
    resolved: 0,
    unable_to_verify: 0
  }
  const settledRepeats = new Set(
    comparison.items
      .filter(
        (i) => i.previous && i.suggestedId && effectiveStatus(i, overrides) === 'still_present'
      )
      .map((i) => `new:${i.suggestedId}`)
  )
  for (const item of comparison.items) {
    if (settledRepeats.has(item.key)) continue
    const status = effectiveStatus(item, overrides)
    if (!item.previous && status === 'still_present') continue // counted on its previous item
    counts[status]++
  }
  return counts
}

export interface CurrentLifecycle {
  status: Lifecycle
  /** It continues a finding that was already posted to GitHub. */
  previouslyPosted: boolean
}

/** How each finding of this review relates to the previous review, after overrides. */
export function currentLifecycle(
  comparison: Comparison,
  overrides: Readonly<Record<string, Override>> = {}
): Map<string, CurrentLifecycle> {
  overrides = expandOverrides(comparison, overrides)
  const out = new Map<string, CurrentLifecycle>()
  const byPrevious = new Map(
    comparison.items.filter((i) => i.previous).map((i) => [i.previous!.id, i])
  )
  for (const item of comparison.items) {
    const status = effectiveStatus(item, overrides)
    if (item.previous) {
      const id = status === 'still_present' ? (item.currentId ?? item.suggestedId) : item.currentId
      if (id) out.set(id, { status, previouslyPosted: item.previousPosted })
    } else if (item.currentId && !out.has(item.currentId)) {
      const prev = item.suggestedId ? byPrevious.get(item.suggestedId) : undefined
      out.set(item.currentId, {
        status,
        previouslyPosted: status === 'still_present' && !!prev?.previousPosted
      })
    }
  }
  return out
}

/**
 * Findings picked for posting by default: blocking and should-fix ones that haven't been
 * posted. After an incremental review, only New ones: still-present and uncertain findings
 * stay unticked until the user ticks them, so nothing is reposted by default.
 */
export function defaultPostSelection(
  findings: readonly Finding[],
  posted: ReadonlySet<string>,
  lifecycle: ReadonlyMap<string, CurrentLifecycle> | null
): Set<string> {
  return new Set(
    findings
      .filter((f) => f.severity !== 'nit' && !posted.has(f.id))
      .filter((f) => !lifecycle || lifecycle.get(f.id)?.status === 'new')
      .map((f) => f.id)
  )
}

/** Ids posted from an entry, including findings it continued from posted ones. */
export function postedLineage(
  posted: readonly { findingIds: string[] }[] | undefined,
  comparison: Comparison | null | undefined
): Set<string> {
  const ids = new Set((posted ?? []).flatMap((p) => p.findingIds))
  for (const item of comparison?.items ?? []) {
    if (item.previousPosted && item.currentId && item.status === 'still_present')
      ids.add(item.currentId)
  }
  return ids
}

// --- Offering an incremental review ----------------------------------------------------------

export interface ParentCandidate {
  id: string
  prUrl: string
  startedAt: number
  status: 'done' | 'error'
  headSha: string | null
  /** Null when the review has no structured findings. */
  verdict: string | null
}

export const SHA = /^[0-9a-f]{40}$/

const prKey = (url: string): string | null => parsePrUrl(url)?.url.toLowerCase() ?? null

/** The newest finished review of the same PR; incremental runs need a commit and findings. */
export function chooseParent<T extends ParentCandidate>(
  entries: readonly T[],
  prUrl: string,
  preferId?: string
): T | null {
  const key = prKey(prUrl)
  if (!key) return null
  const same = entries.filter((e) => e.status === 'done' && prKey(e.prUrl) === key)
  if (preferId) return same.find((e) => e.id === preferId) ?? null
  return [...same].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}

export type CompareStatus = 'ahead' | 'identical' | 'behind' | 'diverged'

export type OfferReason =
  'no_commit' | 'no_findings' | 'same_commit' | 'diverged' | 'unknown_head' | 'compare_failed'

export const OFFER_MESSAGES: Record<OfferReason, string> = {
  no_commit: "The previous review didn't record which commit it saw, so a full review is needed.",
  no_findings: 'The previous review has no structured findings to compare against.',
  same_commit: 'No new commits since the previous review.',
  diverged:
    "The PR was force-pushed or rebased since the previous review, so its commit isn't part of the PR any more. A full review is needed.",
  unknown_head: "PR Hub couldn't read the PR's current commit.",
  compare_failed: "PR Hub couldn't check how the PR changed since the previous review."
}

/** Whether an incremental review can be offered, from the GitHub compare of the two commits. */
export function offerReason(
  parent: ParentCandidate,
  headSha: string | null,
  compare: CompareStatus | null
): OfferReason | null {
  if (!parent.headSha || !SHA.test(parent.headSha)) return 'no_commit'
  if (!parent.verdict) return 'no_findings'
  if (!headSha || !SHA.test(headSha)) return 'unknown_head'
  if (headSha === parent.headSha || compare === 'identical') return 'same_commit'
  if (compare === null) return 'compare_failed'
  if (compare !== 'ahead') return 'diverged'
  return null
}
