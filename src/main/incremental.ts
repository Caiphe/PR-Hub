import { execFile } from 'child_process'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Findings } from '../shared/findings'
import type { HistoryEntry } from '../shared/history'
import {
  compareFindings,
  OFFER_MESSAGES,
  parseUnifiedDiff,
  postedLineage,
  SHA
} from '../shared/incremental'
import type { IncrementalOutcome } from '../shared/ipc'
import { parsePrUrl } from '../shared/validate'

// Prepares an incremental review after the skill's fetch script has cloned the PR. The app
// (never the model) runs git here, with argument arrays and only validated commit SHAs, and
// writes what the reviewer reads next to the fetch output:
//   incremental.diff          changes since the previous review, limited to the PR's files
//   incremental-u0.diff       the same without context, for mapping old lines to new ones
//   incremental-commits.txt   the commits since the previous review
//   incremental.json          whether this run is incremental, or why it fell back to full

export const INCREMENTAL_MARKER = 'incremental.json'
const GIT_TIMEOUT_MS = 2 * 60 * 1000
// Above this many paths the diff isn't narrowed: passing them as arguments gets unwieldy, and
// a PR that size is better reviewed in full context anyway.
const MAX_PATHS = 400

export type Prepared =
  | { ok: true; comparedSha: string; commits: string; changedFiles: number }
  | { ok: false; reason: string }

export type Marker =
  { mode: 'incremental'; comparedSha: string } | { mode: 'full'; fallbackReason: string }

export const FALLBACK = {
  badSha: "The previous review's commit isn't a valid commit id, so a full review is needed.",
  missing:
    "The previous review's commit isn't part of the PR any more (it was force-pushed or rebased), so a full review is needed.",
  notAncestor:
    "The PR was rebased or force-pushed since the previous review, so its changes since then can't be isolated. A full review is needed.",
  noChanges:
    'Nothing changed in the PR since the previous review, so a full review was run instead.',
  gitFailed: "PR Hub couldn't compare the two commits, so a full review is needed."
} as const

interface GitResult {
  code: number
  stdout: string
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repo, '-c', 'core.quotePath=false', ...args],
      { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        resolve({ code, stdout: String(stdout) })
      }
    )
  })
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean)

/** Paths the PR touches between its merge base with the base branch and `commit`. */
async function prFiles(repo: string, commit: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const base = await git(repo, ['merge-base', 'base', commit], env)
  const mb = base.stdout.trim()
  if (base.code !== 0 || !SHA.test(mb)) return []
  const diff = await git(repo, ['diff', '--name-only', '-M', mb, commit], env)
  return diff.code === 0 ? lines(diff.stdout) : []
}

export async function prepareIncremental(
  prDir: string,
  previousSha: string,
  /** Files previous findings point at, so changes there are seen even outside the PR's files. */
  findingFiles: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<Prepared> {
  const repo = join(prDir, 'repo')
  const fail = async (reason: string): Promise<Prepared> => {
    await writeMarker(prDir, { mode: 'full', fallbackReason: reason })
    return { ok: false, reason }
  }
  if (!SHA.test(previousSha)) return fail(FALLBACK.badSha)

  const head = (await git(repo, ['rev-parse', 'pr'], env)).stdout.trim()
  if (!SHA.test(head)) return fail(FALLBACK.gitFailed)
  if (head === previousSha) return fail(FALLBACK.noChanges)
  const exists = await git(repo, ['cat-file', '-e', `${previousSha}^{commit}`], env)
  if (exists.code !== 0) return fail(FALLBACK.missing)
  const ancestor = await git(repo, ['merge-base', '--is-ancestor', previousSha, 'pr'], env)
  if (ancestor.code === 1) return fail(FALLBACK.notAncestor)
  if (ancestor.code !== 0) return fail(FALLBACK.gitFailed)

  // Limit to files of the PR (now or at the previous review) and of previous findings, so a
  // merge of the base branch into the PR doesn't bring unrelated changes along.
  const paths = [
    ...new Set([
      ...(await prFiles(repo, 'pr', env)),
      ...(await prFiles(repo, previousSha, env)),
      ...findingFiles
    ])
  ]
  const scope = paths.length > 0 && paths.length <= MAX_PATHS ? ['--', ...paths] : []
  const range = [previousSha, 'pr']
  const [full, compact, log] = await Promise.all([
    git(repo, ['diff', '-M', '--no-color', ...range, ...scope], env),
    git(repo, ['diff', '-M', '-U0', '--no-color', ...range, ...scope], env),
    git(repo, ['log', '--format=%h %an: %s', `${previousSha}..pr`], env)
  ])
  if (full.code !== 0 || compact.code !== 0 || log.code !== 0) return fail(FALLBACK.gitFailed)

  await Promise.all([
    writeFile(join(prDir, 'incremental.diff'), full.stdout),
    writeFile(join(prDir, 'incremental-u0.diff'), compact.stdout),
    writeFile(join(prDir, 'incremental-commits.txt'), log.stdout)
  ])
  await writeMarker(prDir, { mode: 'incremental', comparedSha: previousSha })
  return {
    ok: true,
    comparedSha: previousSha,
    commits: log.stdout.trim(),
    changedFiles: (full.stdout.match(/^diff --git /gm) ?? []).length
  }
}

function writeMarker(prDir: string, marker: Marker): Promise<void> {
  return writeFile(join(prDir, INCREMENTAL_MARKER), JSON.stringify(marker))
}

/** What prepareIncremental decided, plus the line-mapping diff, read before the checkout goes. */
export async function readIncrementalOutcome(
  prDir: string
): Promise<{ marker: Marker; compactDiff: string | null } | null> {
  let marker: Marker
  try {
    const raw = JSON.parse(await readFile(join(prDir, INCREMENTAL_MARKER), 'utf8')) as Marker
    if (raw.mode === 'incremental' && SHA.test(raw.comparedSha)) marker = raw
    else if (raw.mode === 'full' && typeof raw.fallbackReason === 'string') marker = raw
    else return null
  } catch {
    return null
  }
  const compactDiff =
    marker.mode === 'incremental'
      ? await readFile(join(prDir, 'incremental-u0.diff'), 'utf8').catch(() => null)
      : null
  return { marker, compactDiff }
}

/** Why a requested parent can't be compared against, or null when it can. */
export function parentProblem(parent: HistoryEntry | null, prUrl: string): string | null {
  if (!parent || parent.status !== 'done') return 'The previous review is no longer in history.'
  const same =
    parsePrUrl(parent.input.prUrl)?.url.toLowerCase() === parsePrUrl(prUrl)?.url.toLowerCase()
  if (!same) return 'The previous review is of a different PR.'
  if (!parent.headSha || !SHA.test(parent.headSha)) return OFFER_MESSAGES.no_commit
  if (!parent.result?.findings) return OFFER_MESSAGES.no_findings
  return null
}

/**
 * The history fields and renderer outcome for a finished run that was asked to be incremental.
 * `preset`: a reason decided before the run (the parent turned out unusable).
 */
export function incrementalRecord(args: {
  parent: HistoryEntry | null
  parentId: string
  preset: string | null
  outcome: Awaited<ReturnType<typeof readIncrementalOutcome>>
  findings: Findings | null
}): {
  fields: Pick<HistoryEntry, 'incremental' | 'fallbackReason'>
  outcome: IncrementalOutcome
} | null {
  const { parent, parentId, preset, outcome, findings } = args
  const fallback = (reason: string): ReturnType<typeof incrementalRecord> => ({
    fields: { fallbackReason: reason },
    outcome: { parentId, comparedSha: null, comparison: null, fallbackReason: reason }
  })
  if (preset) return fallback(preset)
  // No marker: the run stopped before the comparison step (e.g. the fetch failed).
  if (!outcome) return null
  if (outcome.marker.mode === 'full') return fallback(outcome.marker.fallbackReason)

  const comparedSha = outcome.marker.comparedSha
  const previous = parent?.result?.findings
  const comparison =
    findings && previous && parent
      ? compareFindings({
          parentId,
          comparedSha,
          previousVerdict: previous.verdict,
          previous: previous.findings,
          current: findings.findings,
          model: findings.previous_findings,
          diff: outcome.compactDiff === null ? null : parseUnifiedDiff(outcome.compactDiff),
          previousPosted: postedLineage(parent.posted, parent.incremental?.comparison)
        })
      : null
  return {
    fields: { incremental: { parentId, comparedSha, comparison } },
    outcome: { parentId, comparedSha, comparison, fallbackReason: null }
  }
}
