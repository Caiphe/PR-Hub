import { app, ipcMain, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import type { HistoryEntry } from '../shared/history'
import {
  IPC,
  type ReplayVariant,
  type ReviewEvent,
  type ReviewEventBody,
  type StartReviewResult
} from '../shared/ipc'
import { parsePrUrl, validateReviewInput, type ReviewInput } from '../shared/validate'
import { loadSkill, resolveReviewEnvironment, type ReviewEnvironment } from './environment'
import { HistoryStore } from './historyStore'
import { replayFixture } from './replay'
import { runReview, type ReviewHandle } from './reviewRunner'

const running = new Map<string, ReviewHandle>()
let environment: Promise<ReviewEnvironment> | null = null
let history: HistoryStore

const reviewsDir = (): string => join(app.getPath('userData'), 'reviews')

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
async function finishReview(
  reviewId: string,
  input: ReviewInput,
  startedAt: number,
  event: ReviewEventBody
): Promise<void> {
  const workDir = join(reviewsDir(), reviewId)
  if (event.type === 'cancelled') return removeDir(workDir)
  const headSha = await readReviewedHead(join(workDir, 'pr/repo'))
  await removeDir(join(workDir, 'pr'))
  if (event.type !== 'done' && event.type !== 'error') return

  const entry: HistoryEntry = {
    id: reviewId,
    input,
    startedAt,
    endedAt: Date.now(),
    status: event.type,
    result: event.type === 'done' ? event.result : null,
    error: event.type === 'error' ? event.message : null,
    ...(headSha ? { headSha } : {})
  }
  const trimmed = await history.add(entry)
  await Promise.all(trimmed.map((id) => removeDir(join(reviewsDir(), id))))
}

async function startReview(sender: WebContents, raw: unknown): Promise<StartReviewResult> {
  // Re-validate at the IPC boundary: the renderer is not trusted to have done it.
  const candidate = (raw ?? {}) as Partial<ReviewInput>
  const input: ReviewInput = {
    title: String(candidate.title ?? '').trim(),
    prUrl: String(candidate.prUrl ?? '').trim(),
    description: String(candidate.description ?? '').trim()
  }
  const errors = validateReviewInput(input)
  if (Object.keys(errors).length > 0) return { ok: false, error: Object.values(errors)[0]! }
  input.prUrl = parsePrUrl(input.prUrl)!.url

  try {
    const [env, skill] = await Promise.all([getEnvironment(), loadSkill()])
    const reviewId = randomUUID()
    const workDir = join(reviewsDir(), reviewId)
    await mkdir(workDir, { recursive: true })
    const startedAt = Date.now()

    const handle = runReview({
      input,
      workDir,
      claudePath: env.claudePath,
      env: env.env,
      skill,
      model: process.env.PR_HUB_MODEL || undefined,
      emit: (body) => {
        send(sender, { ...body, reviewId })
        if (body.type === 'done' || body.type === 'error' || body.type === 'cancelled') {
          finishReview(reviewId, input, startedAt, body).catch((error) =>
            console.error('Failed to record review', error)
          )
        }
      }
    })
    running.set(reviewId, handle)
    handle.finished.then(() => running.delete(reviewId))
    return { ok: true, reviewId }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

const REPLAY_VARIANTS: ReplayVariant[] = ['full', 'no-findings', 'error']

function replay(sender: WebContents, variant: unknown): StartReviewResult {
  const v = REPLAY_VARIANTS.includes(variant as ReplayVariant) ? (variant as ReplayVariant) : 'full'
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

export function registerReviewIpc(): void {
  history = new HistoryStore(join(app.getPath('userData'), 'history.json'))

  ipcMain.handle(IPC.startReview, (event, input) => startReview(event.sender, input))
  ipcMain.handle(IPC.cancelReview, (_event, reviewId: unknown) => {
    if (typeof reviewId === 'string') running.get(reviewId)?.cancel()
  })
  ipcMain.handle(IPC.listHistory, () => history.list())
  ipcMain.handle(IPC.getHistory, (_event, id: unknown) =>
    typeof id === 'string' ? history.get(id) : null
  )
  // Fixture replay exists only in development builds; packaged apps never register it.
  if (is.dev) ipcMain.handle(IPC.replayFixture, (event, variant) => replay(event.sender, variant))

  sweepOrphanedReviewDirs().catch((error) => console.error('Review folder sweep failed', error))

  // Don't leave headless sessions running after the window is gone.
  app.on('before-quit', () => running.forEach((handle) => handle.cancel()))
}
