import { app, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import type { HistoryEntry } from '../shared/history'
import {
  IPC,
  REPLAY_VARIANTS,
  type ReplayVariant,
  type ReviewEvent,
  type IncrementalOutcome,
  type ReviewEventBody,
  type StartReviewResult
} from '../shared/ipc'
import { reviewRunSettings } from '../shared/settings'
import { parsePrUrl, TASK_SOURCES, validateReviewInput, type ReviewInput } from '../shared/validate'
import { loadSkill, resolveReviewEnvironment, type ReviewEnvironment } from './environment'
import { HistoryStore } from './historyStore'
import { incrementalRecord, parentProblem, readIncrementalOutcome } from './incremental'
import { handle } from './ipcGuard'
import { replayFixture } from './replay'
import { runReview, type ReviewHandle } from './reviewRunner'
import { getSettings } from './settings'

const running = new Map<string, ReviewHandle>()
let environment: Promise<ReviewEnvironment> | null = null
let history: HistoryStore
let onFinished: ReviewFinishedListener = () => {}

/** Called when a real (non-replay) review completes or fails. */
export type ReviewFinishedListener = (input: ReviewInput, event: ReviewEventBody) => void

export const reviewsDir = (): string => join(app.getPath('userData'), 'reviews')

export function getHistory(): HistoryStore {
  return history
}

export function getEnvironment(): Promise<ReviewEnvironment> {
  // Cached on success only, so installing claude and retrying works without a restart.
  environment ??= resolveReviewEnvironment().catch((error) => {
    environment = null
    throw error
  })
  return environment
}

function send(target: WebContents, event: ReviewEvent): void {
  if (!target.isDestroyed()) target.send(IPC.reviewEvent, event)
}

const removeDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true }).catch((error) =>
    console.error(`Failed to remove ${path}`, error)
  )

// The skill's fetch script checks the PR head out as branch "pr". Reading the ref file
// directly avoids spawning git; packed-refs covers the rare case where git packed it.
async function readReviewedHead(repoDir: string): Promise<string | undefined> {
  const isSha = (s: string | undefined): s is string => !!s && /^[0-9a-f]{40}$/.test(s)
  const loose = (await readFile(join(repoDir, '.git/refs/heads/pr'), 'utf8').catch(() => '')).trim()
  if (isSha(loose)) return loose
  const packed = await readFile(join(repoDir, '.git/packed-refs'), 'utf8').catch(() => '')
  const sha = /^([0-9a-f]{40}) refs\/heads\/pr$/m.exec(packed)?.[1]
  return isSha(sha) ? sha : undefined
}

// Called once per review with its terminal event. Saves finished reviews and frees disk:
// the PR checkout (often the largest thing here) goes right away; stream.jsonl stays
// for debugging until the entry is trimmed out of history.
/** An incremental request: the parent to compare against, or why it can't be used. */
interface IncrementalPlan {
  parentId: string
  parent: HistoryEntry | null
  preset: string | null
}

async function finishReview(
  reviewId: string,
  input: ReviewInput,
  startedAt: number,
  event: ReviewEventBody,
  plan: IncrementalPlan | null
): Promise<{ headSha?: string; incremental?: IncrementalOutcome }> {
  const workDir = join(reviewsDir(), reviewId)
  if (event.type === 'cancelled') {
    await removeDir(workDir)
    return {}
  }
  const headSha = await readReviewedHead(join(workDir, 'pr/repo'))
  // Read the comparison step's result before the checkout (where it lives) is deleted.
  const record = plan
    ? incrementalRecord({
        parent: plan.parent,
        parentId: plan.parentId,
        preset: plan.preset,
        outcome: await readIncrementalOutcome(join(workDir, 'pr')),
        findings: event.type === 'done' ? event.result.findings : null
      })
    : null
  await removeDir(join(workDir, 'pr'))
  if (event.type !== 'done' && event.type !== 'error') return { headSha }

  const entry: HistoryEntry = {
    id: reviewId,
    input,
    startedAt,
    endedAt: Date.now(),
    status: event.type,
    result: event.type === 'done' ? event.result : null,
    error: event.type === 'error' ? event.message : null,
    ...(headSha ? { headSha } : {}),
    ...record?.fields
  }
  const trimmed = await history.add(entry)
  await Promise.all(trimmed.map((id) => removeDir(join(reviewsDir(), id))))
  return { headSha, ...(record ? { incremental: record.outcome } : {}) }
}

async function startReview(
  sender: WebContents,
  raw: unknown,
  rawOptions: unknown
): Promise<StartReviewResult> {
  // Re-validate at the IPC boundary: the renderer is not trusted to have done it.
  const candidate = (raw ?? {}) as Partial<ReviewInput>
  const input: ReviewInput = {
    title: String(candidate.title ?? '').trim(),
    prUrl: String(candidate.prUrl ?? '').trim(),
    description: String(candidate.description ?? '').trim(),
    // Anything unrecognized counts as written by the user.
    taskSource: TASK_SOURCES.find((s) => s === candidate.taskSource) ?? 'manual'
  }
  const errors = validateReviewInput(input)
  if (Object.keys(errors).length > 0) return { ok: false, error: Object.values(errors)[0]! }
  input.prUrl = parsePrUrl(input.prUrl)!.url

  // The parent comes from history in main, never from the renderer: only its id is read.
  const parentId = (rawOptions as { incrementalFrom?: unknown } | null)?.incrementalFrom
  let plan: IncrementalPlan | null = null
  if (typeof parentId === 'string' && parentId) {
    const parent = await history.get(parentId)
    plan = { parentId, parent, preset: parentProblem(parent, input.prUrl) }
  }
  const parentFindings = plan && !plan.preset ? plan.parent!.result!.findings! : null

  try {
    const [env, skill] = await Promise.all([getEnvironment(), loadSkill()])
    const reviewId = randomUUID()
    const workDir = join(reviewsDir(), reviewId)
    await mkdir(workDir, { recursive: true })
    const startedAt = Date.now()
    // Read once: a running review keeps the model and timeout it started with.
    const { model, timeoutMs } = reviewRunSettings(getSettings(), process.env.PR_HUB_MODEL)

    const handle = runReview({
      input,
      workDir,
      claudePath: env.claudePath,
      env: env.env,
      skill,
      model,
      timeoutMs,
      ...(parentFindings
        ? {
            incremental: {
              previousSha: plan!.parent!.headSha!,
              previousFindings: parentFindings.findings
            }
          }
        : {}),
      emit: (body) => {
        if (body.type !== 'done' && body.type !== 'error' && body.type !== 'cancelled') {
          return send(sender, { ...body, reviewId })
        }
        // Save before telling the renderer, so actions on the finished review (like posting
        // to GitHub, which reads it from history) can't race the write.
        finishReview(reviewId, input, startedAt, body, plan)
          .catch((error) => {
            console.error('Failed to record review', error)
            return {} as Awaited<ReturnType<typeof finishReview>>
          })
          .then(({ headSha, incremental }) => {
            // The reviewed commit lets the window link findings to the exact lines on GitHub.
            const out =
              body.type === 'done'
                ? {
                    ...body,
                    ...(headSha ? { headSha } : {}),
                    ...(incremental ? { incremental } : {})
                  }
                : body
            send(sender, { ...out, reviewId })
            if (body.type !== 'cancelled') onFinished(input, body)
          })
      }
    })
    running.set(reviewId, handle)
    handle.finished.then(() => running.delete(reviewId))
    return { ok: true, reviewId }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

function replay(sender: WebContents, variant: unknown): StartReviewResult {
  const v: ReplayVariant = REPLAY_VARIANTS.find((known) => known === variant) ?? 'full'
  const reviewId = randomUUID()
  const handle = replayFixture(join(app.getAppPath(), 'fixtures/sample-stream.jsonl'), v, (body) =>
    send(sender, { ...body, reviewId })
  )
  running.set(reviewId, handle)
  handle.finished.then(() => running.delete(reviewId))
  return { ok: true, reviewId }
}

// Review folders that aren't in history and aren't running are leftovers from a crash
// or a quit mid-review.
async function sweepOrphanedReviewDirs(): Promise<void> {
  const keep = await history.ids()
  const dirs = await readdir(reviewsDir()).catch(() => [] as string[])
  await Promise.all(
    dirs
      .filter((id) => !keep.has(id) && !running.has(id))
      .map((id) => removeDir(join(reviewsDir(), id)))
  )
}

export function registerReviewIpc(options: { onFinished?: ReviewFinishedListener } = {}): void {
  if (options.onFinished) onFinished = options.onFinished
  // The limit is read on each save, so a changed retention setting applies to the next review.
  history = new HistoryStore(
    join(app.getPath('userData'), 'history.json'),
    () => getSettings().historyLimit
  )

  handle(IPC.startReview, (event, input, options) => startReview(event.sender, input, options))
  handle(IPC.cancelReview, (_event, reviewId: unknown) => {
    if (typeof reviewId === 'string') running.get(reviewId)?.cancel()
  })
  handle(IPC.listHistory, () => history.list())
  handle(IPC.getHistory, (_event, id: unknown) => (typeof id === 'string' ? history.get(id) : null))
  // Fixture replay exists only in development builds; packaged apps never register it.
  if (is.dev) handle(IPC.replayFixture, (event, variant) => replay(event.sender, variant))

  sweepOrphanedReviewDirs().catch((error) => console.error('Review folder sweep failed', error))
}

export function hasRunningReviews(): boolean {
  return running.size > 0
}

/** Cancels every running review and waits (bounded) for their processes to exit. */
export async function cancelAllReviews(timeoutMs: number): Promise<void> {
  const handles = [...running.values()]
  handles.forEach((h) => h.cancel())
  await Promise.race([
    Promise.all(handles.map((h) => h.finished)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ])
}
