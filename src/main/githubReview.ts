import type { Finding, Findings } from '../shared/findings'
import type { BodyFinding, InlineComment, PostMode } from '../shared/github'
import { codeFence, languageForFile, looksLikeProse, sanitizeForGitHub } from '../shared/markdown'

// Pure mapping from findings to a GitHub "create a review" payload:
// POST /repos/{owner}/{repo}/pulls/{number}/reviews
// GitHub rejects the whole review if any inline comment points at a line outside the
// diff, so every inline comment is checked against the PR's patches first.

export interface ReviewPayload {
  commit_id: string
  event: 'COMMENT' | 'REQUEST_CHANGES'
  body: string
  comments: Array<{ path: string; line: number; side: 'RIGHT'; body: string }>
}

export interface PrFile {
  filename: string
  /** Absent for binary or very large files. */
  patch?: string
}

/** New-side line numbers a review comment may target: added and context lines in each hunk. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>()
  if (!patch) return lines
  let next = 0
  let inHunk = false
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) {
      next = Number(hunk[1])
      inHunk = true
    } else if (!inHunk || row.startsWith('-') || row.startsWith('\\')) {
      continue
    } else {
      // '+' added, ' ' context (an empty row is a blank context line with its space trimmed).
      lines.add(next++)
    }
  }
  return lines
}

export function commentableMap(files: PrFile[]): Map<string, Set<number>> {
  return new Map(files.map((f) => [f.filename, commentableLines(f.patch)]))
}

const SEVERITY: Record<Finding['severity'], string> = {
  blocking: '🔴 Blocking',
  should_fix: '🟡 Should fix',
  nit: '🟢 Nit'
}

const VERDICT: Record<Findings['verdict'], string> = {
  approve: '✅ Approve',
  approve_with_suggestions: '💬 Approve with suggestions',
  request_changes: '🔁 Request changes'
}

function location(f: Finding): string {
  if (!f.file) return ''
  return ` · \`${f.line ? `${f.file}:${f.line}` : f.file}\``
}

function suggestionBlock(f: Finding, inline: boolean): string {
  if (!f.suggestion) return ''
  const code = f.suggestion.replace(/\n$/, '')
  if (looksLikeProse(code)) return `\n\nSuggested fix: ${sanitizeForGitHub(code)}`
  // GitHub applies a ```suggestion to exactly the commented line, so only one-line
  // replacements become one-click suggestions; anything longer would duplicate code.
  if (inline && !code.includes('\n')) return `\n\n${codeFence(code, 'suggestion')}`
  return `\n\nSuggested change:\n\n${codeFence(code, languageForFile(f.file))}`
}

export function inlineCommentBody(f: Finding): string {
  return (
    sanitizeForGitHub(`**${SEVERITY[f.severity]}: ${f.title}**\n\n${f.body}`.trim()) +
    suggestionBlock(f, true)
  )
}

function bodyFindingSection(f: Finding): string {
  return (
    sanitizeForGitHub(`**${SEVERITY[f.severity]}: ${f.title}**${location(f)}\n\n${f.body}`.trim()) +
    suggestionBlock(f, false)
  )
}

export interface BuildInput {
  findings: Findings
  selectedIds: string[]
  mode: PostMode
  headSha: string
  /** From the PR's current files; see commentableMap(). */
  commentable: Map<string, Set<number>>
  /** The PR has new commits since the review ran, so its line numbers may be stale. */
  headMoved: boolean
  /**
   * When headMoved: files that differ between the reviewed commit and the current head. A file
   * not in this set is byte-for-byte the same, so its line numbers still hold. Undefined means
   * unknown (for example after a force-push), and every finding goes in the body.
   */
  changedSinceReview?: ReadonlySet<string>
}

export interface BuiltReview {
  payload: ReviewPayload
  comments: InlineComment[]
  inBody: BodyFinding[]
}

export function buildReview(input: BuildInput): BuiltReview {
  const selected = input.findings.findings.filter((f) => input.selectedIds.includes(f.id))
  const comments: InlineComment[] = []
  const bodyFindings: Finding[] = []
  const inBody: BodyFinding[] = []

  for (const f of selected) {
    let reason: string | null = null
    let movedByChange = false
    if (!f.file || !f.line) {
      reason = 'not tied to a specific line'
    } else if (input.headMoved && !input.changedSinceReview) {
      reason = 'the PR has new commits since the review'
      movedByChange = true
    } else if (input.headMoved && input.changedSinceReview!.has(f.file)) {
      reason = `${f.file} changed since the review, so line ${f.line} may point at different code`
      movedByChange = true
    } else if (!input.commentable.get(f.file)?.has(f.line)) {
      reason = `${f.file}:${f.line} is not part of the PR diff`
    }

    if (reason) {
      bodyFindings.push(f)
      inBody.push(
        movedByChange ? { findingId: f.id, reason, movedByChange } : { findingId: f.id, reason }
      )
    } else {
      comments.push({ findingId: f.id, path: f.file!, line: f.line!, body: inlineCommentBody(f) })
    }
  }

  const sections = [
    `**PR Hub review: ${VERDICT[input.findings.verdict]}**`,
    input.findings.summary && sanitizeForGitHub(input.findings.summary),
    bodyFindings.length > 0 &&
      [
        comments.length > 0 ? '### Other findings' : '### Findings',
        ...bodyFindings.map(bodyFindingSection)
      ].join('\n\n'),
    // Plain markdown (not <sub>) so the in-app preview renders exactly like GitHub will.
    `_Findings generated by Claude (pr-review skill) and posted from PR Hub after review by a person.${
      comments.length > 0 ? ` ${comments.length} inline comment(s) below.` : ''
    }_`
  ].filter(Boolean)

  return {
    payload: {
      commit_id: input.headSha,
      event: input.mode === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT',
      body: sections.join('\n\n'),
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body }))
    },
    comments,
    inBody
  }
}
