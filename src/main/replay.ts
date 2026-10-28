import { readFile } from 'fs/promises'
import type { ReplayVariant, ReviewEventBody } from '../shared/ipc'
import type { ReviewHandle } from './reviewRunner'
import { doneEvent } from './reviewRunner'
import { parseStreamLine, type StreamResult } from './streamParser'

const STEP_DELAY_MS = 350

// Dev-only: plays a recorded stream-json file through the same parser as a live review,
// so the review UI can be worked on without spending a real run. Variants exercise the
// fallback states: 'no-findings' drops the JSON block, 'error' fails partway through.
export function replayFixture(
  fixturePath: string,
  variant: ReplayVariant,
  emit: (event: ReviewEventBody) => void
): ReviewHandle {
  let cancelled = false
  let resolveFinished!: () => void
  const finished = new Promise<void>((resolve) => (resolveFinished = resolve))
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const play = async (): Promise<void> => {
    const lines = (await readFile(fixturePath, 'utf8')).split('\n')
    const workDir = JSON.parse(lines[0]).cwd as string
    let result: StreamResult | null = null
    let toolCount = 0

    emit({ type: 'status', message: 'Starting Claude Code (replay)' })
    for (const line of lines) {
      for (const parsed of parseStreamLine(line, { workDir })) {
        if (cancelled) return emit({ type: 'cancelled' })
        if (parsed.kind === 'result') {
          result = parsed.result
          continue
        }
        emit(parsed.event)
        if (parsed.event.type === 'tool' && ++toolCount === 3 && variant === 'error') {
          await sleep(STEP_DELAY_MS)
          return emit({ type: 'error', message: 'Review failed: simulated failure (replay)' })
        }
        await sleep(STEP_DELAY_MS)
      }
    }
    if (!result) return emit({ type: 'error', message: 'Fixture has no result line' })
    if (variant === 'no-findings') {
      result = { ...result, text: result.text.replace(/```json[\s\S]*```/, '') }
    }
    emit(doneEvent(result))
  }

  play()
    .catch((error) => emit({ type: 'error', message: `Replay failed: ${error.message}` }))
    .finally(resolveFinished)

  return {
    cancel: () => {
      cancelled = true
    },
    finished
  }
}
