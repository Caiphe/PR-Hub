import type { Finding, Requirement } from '../shared/findings'
import type { HistoryEntry } from '../shared/history'
import { codeFence, languageForFile, looksLikeProse } from '../shared/markdown'
import { parsePrUrl } from '../shared/validate'
import { redactSecrets } from './githubErrors'

// Serializes one saved review for "Export". Pure, so the exact output is tested. Exports hold
// what history holds, minus app-internal fields (submission ids, blocked tool names); the raw
// event stream is never read. Every string goes through redactSecrets in case a review quoted
// something token-like from the PR.

export type ExportFormat = 'markdown' | 'json'

export const EXPORT_FORMAT_ID = 'pr-hub-review'
export const EXPORT_VERSION = 1

/** The JSON export schema. Documented in README "History, export and deletion". */
export interface ReviewExport {
  format: typeof EXPORT_FORMAT_ID
  version: typeof EXPORT_VERSION
  exportedAt: string
  review: {
    id: string
    status: 'done' | 'error'
    startedAt: string
    endedAt: string
    durationMs: number
    costUsd: number | null
    pinned: boolean
    task: { title: string; description: string; source: string | null }
    pullRequest: {
      url: string
      owner: string | null
      repo: string | null
      number: number | null
      reviewedCommit: string | null
    }
    verdict: string | null
    summary: string | null
    requirements: Requirement[]
    findings: Finding[]
    /** Why structured findings are missing, when they are. */
    findingsError: string | null
    markdown: string | null
    error: string | null
    posted: { at: string; url: string; mode: string; findingIds: string[] }[]
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T
  }
  return value
}

export function toExport(entry: HistoryEntry, now = Date.now()): ReviewExport {
  const ref = parsePrUrl(entry.input.prUrl)
  const findings = entry.result?.findings ?? null
  return redactDeep({
    format: EXPORT_FORMAT_ID,
    version: EXPORT_VERSION,
    exportedAt: iso(now),
    review: {
      id: entry.id,
      status: entry.status,
      startedAt: iso(entry.startedAt),
      endedAt: iso(entry.endedAt),
      durationMs: entry.result?.durationMs ?? Math.max(0, entry.endedAt - entry.startedAt),
      costUsd: entry.result?.costUsd ?? null,
      pinned: entry.pinned === true,
      task: {
        title: entry.input.title,
        description: entry.input.description,
        source: entry.input.taskSource ?? null
      },
      pullRequest: {
        url: entry.input.prUrl,
        owner: ref?.owner ?? null,
        repo: ref?.repo ?? null,
        number: ref?.number ?? null,
        reviewedCommit: entry.headSha ?? null
      },
      verdict: findings?.verdict ?? null,
      summary: findings?.summary ?? null,
      requirements: findings?.requirements ?? [],
      findings: findings?.findings ?? [],
      findingsError: entry.result?.findingsError ?? null,
      markdown: entry.result?.markdown ?? null,
      error: entry.error,
      posted: (entry.posted ?? []).map((p) => ({
        at: iso(p.at),
        url: p.url,
        mode: p.mode,
        findingIds: p.findingIds
      }))
    }
  })
}

export function exportJson(entry: HistoryEntry, now = Date.now()): string {
  return `${JSON.stringify(toExport(entry, now), null, 2)}\n`
}

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  blocking: 'Blocking',
  should_fix: 'Should fix',
  nit: 'Nit'
}
const VERDICT_LABEL: Record<string, string> = {
  approve: 'Approve',
  approve_with_suggestions: 'Approve with suggestions',
  request_changes: 'Request changes'
}
const REQUIREMENT_LABEL: Record<Requirement['status'], string> = {
  done: 'Done',
  partial: 'Partial',
  missing: 'Missing'
}

const dateText = (isoDate: string): string => `${isoDate.slice(0, 16).replace('T', ' ')} UTC`

function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}

function findingMarkdown(f: Finding): string {
  const parts = [`### ${SEVERITY_LABEL[f.severity]}: ${f.title}`]
  if (f.file) parts.push(`\`${f.line ? `${f.file}:${f.line}` : f.file}\``)
  if (f.body) parts.push(f.body)
  if (f.suggestion) {
    parts.push(
      looksLikeProse(f.suggestion)
        ? `**Suggested fix:** ${f.suggestion}`
        : `**Suggested change:**\n\n${codeFence(f.suggestion, languageForFile(f.file))}`
    )
  }
  return parts.join('\n\n')
}

export function exportMarkdown(entry: HistoryEntry, now = Date.now()): string {
  const { review } = toExport(entry, now)
  const pr = review.pullRequest
  const label = pr.owner ? `${pr.owner}/${pr.repo}#${pr.number}` : pr.url

  const facts = [
    `- **Pull request:** [${label}](${pr.url})`,
    pr.reviewedCommit && `- **Reviewed commit:** \`${pr.reviewedCommit}\``,
    `- **Reviewed:** ${dateText(review.startedAt)}`,
    `- **Status:** ${review.status === 'done' ? 'Done' : 'Failed'}`,
    review.verdict && `- **Verdict:** ${VERDICT_LABEL[review.verdict] ?? review.verdict}`,
    `- **Duration:** ${durationText(review.durationMs)}` +
      (review.costUsd !== null ? ` · **Cost:** $${review.costUsd.toFixed(2)}` : ''),
    ...review.posted.map(
      (p) =>
        `- **Posted to GitHub:** ${dateText(p.at)} as ${p.mode === 'comment' ? 'a comment' : 'a change request'} (${p.findingIds.length} ${p.findingIds.length === 1 ? 'finding' : 'findings'}): ${p.url}`
    )
  ].filter(Boolean)

  const sections = [`# ${review.task.title}`, facts.join('\n')]
  if (review.task.description) sections.push('## Task', review.task.description)
  if (review.summary) sections.push('## Summary', review.summary)
  if (review.requirements.length > 0) {
    sections.push(
      '## Requirements',
      review.requirements
        .map(
          (r) => `- **${REQUIREMENT_LABEL[r.status]}:** ${r.text}${r.notes ? ` (${r.notes})` : ''}`
        )
        .join('\n')
    )
  }
  if (review.findings.length > 0) {
    sections.push('## Findings', ...review.findings.map(findingMarkdown))
  }
  if (review.markdown) sections.push('## Full review', review.markdown)
  if (review.error) sections.push('## Error', codeFence(review.error))
  sections.push(`---\n\nExported from PR Hub on ${dateText(iso(now))}.`)
  return `${sections.join('\n\n')}\n`
}

/** A safe default file name, e.g. pr-hub-owner-repo-82-2026-10-29.md. */
export function exportFileName(entry: HistoryEntry, format: ExportFormat): string {
  const ref = parsePrUrl(entry.input.prUrl)
  const base = ref ? `${ref.owner}-${ref.repo}-${ref.number}` : 'review'
  const date = iso(entry.startedAt).slice(0, 10)
  const safe = `pr-hub-${base}-${date}`.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `${safe}.${format === 'json' ? 'json' : 'md'}`
}
