import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { Finding, PreviousFinding } from '../shared/findings'
import { compareFindings, parseUnifiedDiff } from '../shared/incremental'
import type { ReplayVariant, ReviewEventBody } from '../shared/ipc'
import { FALLBACK } from './incremental'
import type { ReviewHandle } from './reviewRunner'
import { doneEvent } from './reviewRunner'
import { parseStreamLine, type StreamResult } from './streamParser'

const STEP_DELAY_MS = 350

// Dev-only: plays a recorded stream-json file through the same parser as a live review,
// so the review UI can be worked on without spending a real run. Variants exercise the
// fallback states: 'no-findings' drops the JSON block, 'error' fails partway through,
// 'incremental' compares with a made-up previous review (fixtures/incremental-replay.json),
// and 'fallback' is an incremental request that had to run as a full review.
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
    const done = doneEvent(result)
    if (variant === 'fallback' && done.type === 'done') {
      return emit({
        ...done,
        incremental: {
          parentId: 'replay-parent',
          comparedSha: null,
          comparison: null,
          fallbackReason: FALLBACK.notAncestor
        }
      })
    }
    if (variant === 'incremental' && done.type === 'done' && done.result.findings) {
      return emit(await withComparison(done, join(dirname(fixturePath), 'incremental-replay.json')))
    }
    emit(done)
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

interface IncrementalFixture {
  previousSha: string
  headSha: string
  previousVerdict: string
  previous: Finding[]
  links: Record<string, string>
  extraFindings: Finding[]
  model: PreviousFinding[]
  diff: string
  postedPrevious: string[]
}

async function withComparison(
  done: Extract<ReviewEventBody, { type: 'done' }>,
  path: string
): Promise<ReviewEventBody> {
  const fx = JSON.parse(await readFile(path, 'utf8')) as IncrementalFixture
  const findings = done.result.findings!
  const current = [
    ...findings.findings.map((f) => ({ ...f, previous_id: fx.links[f.id] ?? null })),
    ...fx.extraFindings
  ]
  const comparison = compareFindings({
    parentId: 'replay-parent',
    comparedSha: fx.previousSha,
    previousVerdict: fx.previousVerdict,
    previous: fx.previous,
    current,
    model: fx.model,
    diff: parseUnifiedDiff(fx.diff),
    previousPosted: new Set(fx.postedPrevious)
  })
  return {
    ...done,
    headSha: fx.headSha,
    result: {
      ...done.result,
      findings: { ...findings, findings: current, previous_findings: fx.model }
    },
    incremental: {
      parentId: 'replay-parent',
      comparedSha: fx.previousSha,
      comparison,
      fallbackReason: null
    }
  }
}
