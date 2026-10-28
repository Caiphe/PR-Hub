import { app, ipcMain, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { randomUUID } from 'crypto'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { IPC, type ReplayVariant, type ReviewEvent, type StartReviewResult } from '../shared/ipc'
import { parsePrUrl, validateReviewInput, type ReviewInput } from '../shared/validate'
import { loadSkill, resolveReviewEnvironment, type ReviewEnvironment } from './environment'
import { replayFixture } from './replay'
import { runReview, type ReviewHandle } from './reviewRunner'

const running = new Map<string, ReviewHandle>()
let environment: Promise<ReviewEnvironment> | null = null

function getEnvironment(): Promise<ReviewEnvironment> {
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
    const workDir = join(app.getPath('userData'), 'reviews', reviewId)
    await mkdir(workDir, { recursive: true })

    const handle = runReview({
      input,
      workDir,
      claudePath: env.claudePath,
      env: env.env,
      skill,
      model: process.env.PR_HUB_MODEL || undefined,
      emit: (body) => send(sender, { ...body, reviewId })
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

export function registerReviewIpc(): void {
  ipcMain.handle(IPC.startReview, (event, input) => startReview(event.sender, input))
  // Fixture replay exists only in development builds; packaged apps never register it.
  if (is.dev) ipcMain.handle(IPC.replayFixture, (event, variant) => replay(event.sender, variant))
  ipcMain.handle(IPC.cancelReview, (_event, reviewId: unknown) => {
    if (typeof reviewId === 'string') running.get(reviewId)?.cancel()
  })
  // Don't leave headless sessions running after the window is gone.
  app.on('before-quit', () => running.forEach((handle) => handle.cancel()))
}
