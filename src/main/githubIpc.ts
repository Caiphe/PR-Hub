import { randomUUID } from 'crypto'
import type {
  ConnectionStatus,
  GitHubProblem,
  InspectIssueResult,
  InspectPrResult,
  PostMode,
  PostRecord,
  PostResult,
  PreviewResult,
  TokenKind
} from '../shared/github'
import { submissionMarker } from '../shared/github'
import type { HistoryEntry } from '../shared/history'
import { IPC } from '../shared/ipc'
import { parseIssueUrl, parsePrUrl, type PrRef } from '../shared/validate'
import { resolveChildEnv } from './environment'
import { classifyGhFailure, postFailureKind, type GhOperation } from './githubErrors'
import { checkConnection } from './githubHealth'
import {
  changedFilesBetween,
  fetchPrState,
  findGh,
  findSubmittedReview,
  ghAccount,
  GhError,
  resolveGh,
  submitReview
} from './githubPoster'
import { buildReview, commentableMap, type ReviewPayload } from './githubReview'
import { inspectIssue, inspectPr } from './prInspect'
import { handle } from './ipcGuard'
import { getEnvironment, getHistory } from './reviewIpc'

// Posting is two steps so nothing reaches GitHub without the user seeing it first:
// preview builds the exact payload and caches it; post submits only a cached preview.
// The renderer never supplies the payload itself.
//
// Each preview is one submission with a random id, written into the review body as an
// invisible marker. If a post's outcome is unclear (a timeout, a dropped connection, a 5xx),
// PR Hub looks for that marker on the PR instead of guessing, and never retries by itself.

type SubmissionState =
  /** Built, not sent yet (or refused before GitHub accepted anything): can be posted. */
  | 'ready'
  | 'submitting'
  /** Might be on GitHub. The next post looks for the marker before sending anything. */
  | 'uncertain'
  | 'posted'

interface CachedPreview {
  reviewId: string
  ref: PrRef
  payload: ReviewPayload
  mode: PostMode
  findingIds: string[]
  submissionId: string
  ownPr: boolean
  tokenKind?: TokenKind
  state: SubmissionState
  record?: PostRecord
  expiresAt: number
}

const PREVIEW_TTL_MS = 10 * 60 * 1000
const previews = new Map<string, CachedPreview>()

/** Adds a post record unless that submission is already recorded (a recovered post, a retry). */
export function addPostRecord(entry: HistoryEntry, record: PostRecord): HistoryEntry {
  const posted = entry.posted ?? []
  if (record.submissionId && posted.some((p) => p.submissionId === record.submissionId)) {
    return entry
  }
  return { ...entry, posted: [...posted, record] }
}

function errorResult(
  error: unknown,
  operation: GhOperation,
  tokenKind?: TokenKind
): { ok: false; error: string; needsAuth?: boolean; problem?: GitHubProblem } {
  if (error instanceof GhError) {
    return {
      ok: false,
      error: error.message,
      needsAuth: error.needsAuth,
      problem: error.problem(operation, tokenKind)
    }
  }
  return { ok: false, error: (error as Error).message }
}

// gh is found on the login-shell PATH. Reviews also need claude, but GitHub checks must not.
async function githubEnv(): Promise<NodeJS.ProcessEnv> {
  return getEnvironment()
    .then((e) => e.env)
    .catch(() => resolveChildEnv())
}

async function status(prUrl: unknown): Promise<ConnectionStatus> {
  const env = await githubEnv()
  // Only a valid PR link is passed on; anything else checks the login alone.
  const url = typeof prUrl === 'string' ? parsePrUrl(prUrl)?.url : undefined
  return checkConnection({ gh: await findGh(env), env, prUrl: url })
}

// The renderer sends only a link; it is re-validated here before any request is made.
async function inspectPrHandler(prUrl: unknown): Promise<InspectPrResult> {
  const ref = typeof prUrl === 'string' ? parsePrUrl(prUrl) : null
  if (!ref) return { ok: false, error: 'Not a GitHub pull request link.' }
  const env = await githubEnv()
  return inspectPr(ref, { gh: await findGh(env), env })
}

async function inspectIssueHandler(issueUrl: unknown): Promise<InspectIssueResult> {
  const ref = typeof issueUrl === 'string' ? parseIssueUrl(issueUrl) : null
  if (!ref) return { ok: false, error: 'Not a GitHub issue link.' }
  const env = await githubEnv()
  return inspectIssue(ref, { gh: await findGh(env), env })
}

async function preview(
  reviewId: unknown,
  findingIds: unknown,
  mode: unknown
): Promise<PreviewResult> {
  if (typeof reviewId !== 'string' || !Array.isArray(findingIds)) {
    return { ok: false, error: 'Invalid request' }
  }
  const postMode: PostMode = mode === 'request_changes' ? 'request_changes' : 'comment'
  const ids = findingIds.filter((id): id is string => typeof id === 'string')

  // Unclear submissions are kept until the app quits, so they can still be checked.
  for (const [id, cached] of previews) {
    if (cached.expiresAt < Date.now() && cached.state !== 'uncertain') previews.delete(id)
  }

  let tokenKind: TokenKind | undefined
  try {
    const entry = await getHistory().get(reviewId)
    if (!entry?.result?.findings)
      return { ok: false, error: 'This review has no findings to post.' }
    const ref = parsePrUrl(entry.input.prUrl)
    if (!ref) return { ok: false, error: 'This review has an invalid PR link.' }

    const env = await githubEnv()
    const gh = await resolveGh(env)
    const account = await ghAccount(gh, env)
    tokenKind = account.tokenKind
    const pr = await fetchPrState(gh, ref, env)
    // Line numbers are only trusted on the commit the review saw. If the PR moved on, findings
    // in files that haven't changed since keep their lines; the rest go in the body.
    const headKnown = !!entry.headSha
    const headMoved = !headKnown || entry.headSha !== pr.headSha
    const changedSinceReview =
      headKnown && headMoved
        ? await changedFilesBetween(gh, ref, entry.headSha!, pr.headSha, env)
        : null
    const ownPr = !!pr.author && pr.author.toLowerCase() === account.login.toLowerCase()

    const built = buildReview({
      findings: entry.result.findings,
      selectedIds: ids,
      mode: postMode,
      headSha: pr.headSha,
      commentable: commentableMap(pr.files),
      headMoved,
      ...(changedSinceReview ? { changedSinceReview } : {})
    })
    const submissionId = randomUUID()
    const payload = {
      ...built.payload,
      body: `${built.payload.body}\n\n${submissionMarker(submissionId)}`
    }

    const warnings: string[] = []
    if (account.tokenKind === 'fine_grained_pat') {
      warnings.push(
        `gh uses a fine-grained token. GitHub will accept this review only if the token includes ${ref.owner}/${ref.repo} with Pull requests: Read and write; PR Hub can't check that without posting.`
      )
    }
    if (!headKnown) {
      warnings.push(
        "This review didn't record which commit it saw, so findings are posted in the review body instead of on lines."
      )
    } else if (headMoved && !changedSinceReview) {
      warnings.push(
        "The PR has new commits since this review ran, and PR Hub couldn't tell which files changed (for example after a force-push), so every finding goes in the review body. Consider re-running the review."
      )
    } else if (headMoved) {
      const moved = built.inBody.filter((b) => b.movedByChange).length
      warnings.push(
        moved > 0
          ? `The PR has new commits since this review ran. ${moved} finding(s) in files that changed since then moved to the review body; findings in unchanged files stay on their lines.`
          : 'The PR has new commits since this review ran, but none of them touch the files with inline comments, so the comments stay on their lines.'
      )
    }
    const already = new Set((entry.posted ?? []).flatMap((p) => p.findingIds))
    if (ids.some((id) => already.has(id))) {
      warnings.push('Some selected findings were already posted from this review.')
    }
    if ([...previews.values()].some((p) => p.reviewId === reviewId && p.state === 'uncertain')) {
      warnings.push(
        "An earlier post from this review had an unclear outcome and may be on GitHub. Check the PR's reviews before posting this one."
      )
    }

    const previewId = randomUUID()
    previews.set(previewId, {
      reviewId,
      ref,
      payload,
      mode: postMode,
      findingIds: ids,
      submissionId,
      ownPr,
      tokenKind: account.tokenKind,
      state: 'ready',
      expiresAt: Date.now() + PREVIEW_TTL_MS
    })
    return {
      ok: true,
      preview: {
        previewId,
        account: account.login,
        repo: `${ref.owner}/${ref.repo}`,
        mode: postMode,
        reviewedSha: entry.headSha ?? null,
        postingSha: pr.headSha,
        ownPr,
        body: payload.body,
        submissionId,
        comments: built.comments,
        inBody: built.inBody,
        warnings
      }
    }
  } catch (error) {
    return errorResult(error, 'read', tokenKind)
  }
}

type PostFailure = Extract<PostResult, { ok: false }>

function fail(
  failure: PostFailure['failure'],
  error: string,
  extra: Partial<PostFailure> = {}
): PostFailure {
  return { ok: false, error, failure, ...extra }
}

/** Marks a submission as posted, records it locally (once), and reports success. */
async function accept(cached: CachedPreview, url: string, recovered: boolean): Promise<PostResult> {
  const record: PostRecord = {
    at: Date.now(),
    url,
    mode: cached.mode,
    findingIds: cached.findingIds,
    submissionId: cached.submissionId
  }
  cached.state = 'posted'
  cached.record = record
  // The review is on GitHub now. Failing to record it locally must not read as a failed
  // post, or a retry would create a duplicate review.
  await getHistory()
    .update(cached.reviewId, (e) => addPostRecord(e, record))
    .catch((error) => console.error('Posted to GitHub but failed to record it', error))
  return recovered ? { ok: true, record, recovered } : { ok: true, record }
}

const UNCLEAR = "GitHub didn't confirm the post, and PR Hub can't tell whether it arrived."

/**
 * Looks for the submission's marker on the PR. Read-only: never posts. Returns the outcome when
 * it's settled (found), or the failure to show when it isn't.
 */
async function lookUp(
  cached: CachedPreview,
  gh: string,
  env: NodeJS.ProcessEnv,
  problem?: GitHubProblem
): Promise<PostResult> {
  try {
    const url = await findSubmittedReview(
      gh,
      cached.ref,
      submissionMarker(cached.submissionId),
      env
    )
    if (url) return accept(cached, url, true)
    return fail(
      'ambiguous',
      `${UNCLEAR} PR Hub checked the PR's reviews and none of them is this submission, so it most likely didn't arrive.`,
      { checked: 'not_found', ...(problem ? { problem } : {}) }
    )
  } catch {
    return fail(
      'ambiguous',
      `${UNCLEAR} PR Hub also couldn't list the PR's reviews to check. Look at the PR on GitHub before posting again.`,
      { checked: 'lookup_failed', ...(problem ? { problem } : {}) }
    )
  }
}

function findCached(previewId: unknown): CachedPreview | null {
  const cached = typeof previewId === 'string' ? previews.get(previewId) : undefined
  if (!cached) return null
  if (cached.expiresAt < Date.now() && cached.state !== 'uncertain') return null
  return cached
}

/**
 * Submits a cached preview exactly as built. Called only from an explicit click. After an
 * unclear outcome it first looks for the review on GitHub, and only sends again if it isn't
 * there (or if the user chose `force` because that check itself keeps failing).
 */
async function post(previewId: unknown, options: unknown): Promise<PostResult> {
  const cached = findCached(previewId)
  if (!cached) {
    return fail('needs_new_preview', 'This preview has expired. Build it again to post.')
  }
  if (cached.state === 'posted' && cached.record) return { ok: true, record: cached.record }
  if (cached.state === 'submitting') {
    return fail('busy', 'This review is already being posted.')
  }
  if (cached.mode === 'request_changes' && cached.ownPr) {
    return fail('needs_new_preview', "GitHub doesn't allow requesting changes on your own PR.", {
      problem: classifyGhFailure('request changes on your own pull request', {
        operation: 'post'
      })
    })
  }
  const force = (options as { force?: unknown } | undefined)?.force === true

  const wasUncertain = cached.state === 'uncertain'
  cached.state = 'submitting'
  let gh: string
  let env: NodeJS.ProcessEnv
  try {
    env = await githubEnv()
    gh = await resolveGh(env)
  } catch (error) {
    cached.state = wasUncertain ? 'uncertain' : 'ready'
    const r = errorResult(error, 'post', cached.tokenKind)
    return fail('needs_auth', r.error, r.problem ? { problem: r.problem } : {})
  }

  if (wasUncertain) {
    const found = await lookUp(cached, gh, env)
    if (found.ok) return found
    if (found.checked === 'lookup_failed' && !force) {
      cached.state = 'uncertain'
      return found
    }
  }

  try {
    const url = await submitReview(gh, cached.ref, cached.payload, env)
    return accept(cached, url, false)
  } catch (error) {
    const r = errorResult(error, 'post', cached.tokenKind)
    const kind =
      error instanceof GhError && r.problem ? postFailureKind(r.problem, error.raw) : 'ambiguous'
    if (kind === 'ambiguous') {
      cached.state = 'uncertain'
      // Never retry here. Only look, so the user decides with the facts in hand.
      const found = await lookUp(cached, gh, env, r.problem)
      if (!found.ok) cached.state = 'uncertain'
      return found
    }
    if (kind === 'needs_new_preview') previews.delete(previewId as string)
    else cached.state = 'ready'
    return fail(kind, r.error, r.problem ? { problem: r.problem } : {})
  }
}

/** Looks for a submission with an unclear outcome on GitHub, without posting anything. */
async function verify(previewId: unknown): Promise<PostResult> {
  const cached = findCached(previewId)
  if (!cached) return fail('needs_new_preview', 'This preview has expired.')
  if (cached.state === 'posted' && cached.record) return { ok: true, record: cached.record }
  if (cached.state !== 'uncertain') {
    return fail('retryable', 'This review has not been sent, so there is nothing to check.')
  }
  try {
    const env = await githubEnv()
    const gh = await resolveGh(env)
    return await lookUp(cached, gh, env)
  } catch (error) {
    const r = errorResult(error, 'read', cached.tokenKind)
    return fail('ambiguous', r.error, {
      checked: 'lookup_failed',
      ...(r.problem ? { problem: r.problem } : {})
    })
  }
}

export function registerGithubIpc(): void {
  handle(IPC.previewPost, (_e, reviewId, findingIds, mode) => preview(reviewId, findingIds, mode))
  // Only the preview id (and the force flag) is read: whatever else the renderer sends is ignored.
  handle(IPC.post, (_e, previewId, options) => post(previewId, options))
  handle(IPC.verifyPost, (_e, previewId) => verify(previewId))
  handle(IPC.githubStatus, (_e, prUrl) => status(prUrl))
  handle(IPC.inspectPr, (_e, prUrl) => inspectPrHandler(prUrl))
  handle(IPC.inspectIssue, (_e, issueUrl) => inspectIssueHandler(issueUrl))
}
