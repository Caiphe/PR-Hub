import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { PostMode, PostRecord, PostResult, PreviewResult } from '../shared/github'
import { IPC } from '../shared/ipc'
import { parsePrUrl, type PrRef } from '../shared/validate'
import { fetchPrState, ghAccount, GhError, resolveGh, submitReview } from './githubPoster'
import { buildReview, commentableMap, type ReviewPayload } from './githubReview'
import { getEnvironment, getHistory } from './reviewIpc'

// Posting is two steps so nothing reaches GitHub without the user seeing it first:
// preview builds the exact payload and caches it; post submits only a cached preview.
// The renderer never supplies the payload itself.

interface CachedPreview {
  reviewId: string
  ref: PrRef
  payload: ReviewPayload
  mode: PostMode
  findingIds: string[]
  expiresAt: number
}

const PREVIEW_TTL_MS = 10 * 60 * 1000
const previews = new Map<string, CachedPreview>()

function errorResult(error: unknown): { ok: false; error: string; needsAuth?: boolean } {
  if (error instanceof GhError)
    return { ok: false, error: error.message, needsAuth: error.needsAuth }
  return { ok: false, error: (error as Error).message }
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

  for (const [id, cached] of previews) if (cached.expiresAt < Date.now()) previews.delete(id)

  try {
    const entry = await getHistory().get(reviewId)
    if (!entry?.result?.findings)
      return { ok: false, error: 'This review has no findings to post.' }
    const ref = parsePrUrl(entry.input.prUrl)
    if (!ref) return { ok: false, error: 'This review has an invalid PR link.' }

    const { env } = await getEnvironment()
    const gh = await resolveGh(env)
    const account = await ghAccount(gh, env)
    const pr = await fetchPrState(gh, ref, env)
    const headMoved = !!entry.headSha && entry.headSha !== pr.headSha

    const built = buildReview({
      findings: entry.result.findings,
      selectedIds: ids,
      mode: postMode,
      // Anchor to the commit the review actually saw when we know it.
      headSha: entry.headSha && !headMoved ? entry.headSha : pr.headSha,
      commentable: commentableMap(pr.files),
      headMoved
    })

    const warnings: string[] = []
    if (headMoved) {
      warnings.push(
        'The PR has new commits since this review ran, so findings are posted in the review body instead of on lines. Consider re-running the review.'
      )
    } else if (!entry.headSha) {
      warnings.push(
        "This review didn't record which commit it saw. Line comments assume the PR hasn't changed since."
      )
    }
    const already = new Set((entry.posted ?? []).flatMap((p) => p.findingIds))
    if (ids.some((id) => already.has(id))) {
      warnings.push('Some selected findings were already posted from this review.')
    }

    const previewId = randomUUID()
    previews.set(previewId, {
      reviewId,
      ref,
      payload: built.payload,
      mode: postMode,
      findingIds: ids,
      expiresAt: Date.now() + PREVIEW_TTL_MS
    })
    return {
      ok: true,
      preview: {
        previewId,
        account,
        mode: postMode,
        body: built.payload.body,
        comments: built.comments,
        inBody: built.inBody,
        warnings
      }
    }
  } catch (error) {
    return errorResult(error)
  }
}

async function post(previewId: unknown): Promise<PostResult> {
  const cached = typeof previewId === 'string' ? previews.get(previewId) : undefined
  if (!cached || cached.expiresAt < Date.now()) {
    return { ok: false, error: 'This preview has expired. Open the post dialog again.' }
  }
  // One preview, one post: a double click can't create two reviews.
  previews.delete(previewId as string)

  try {
    const { env } = await getEnvironment()
    const gh = await resolveGh(env)
    const url = await submitReview(gh, cached.ref, cached.payload, env)
    const record: PostRecord = {
      at: Date.now(),
      url,
      mode: cached.mode,
      findingIds: cached.findingIds
    }
    await getHistory().update(cached.reviewId, (e) => ({
      ...e,
      posted: [...(e.posted ?? []), record]
    }))
    return { ok: true, record }
  } catch (error) {
    return errorResult(error)
  }
}

export function registerGithubIpc(): void {
  ipcMain.handle(IPC.previewPost, (_e, reviewId, findingIds, mode) =>
    preview(reviewId, findingIds, mode)
  )
  ipcMain.handle(IPC.post, (_e, previewId) => post(previewId))
}
