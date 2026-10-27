import { spawn } from 'child_process'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { ReviewEventBody } from '../shared/ipc'
import type { ReviewInput } from '../shared/validate'
import { extractFindings } from './extractFindings'
import { buildPrompt, buildSystemPrompt, fetchScriptPath, type SkillContext } from './prompt'
import { parseStreamLine, type StreamResult } from './streamParser'

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const KILL_GRACE_MS = 3000

export interface RunOptions {
  input: ReviewInput
  /** Fresh, empty directory for this review; becomes the child's cwd. */
  workDir: string
  claudePath: string
  env: NodeJS.ProcessEnv
  skill: SkillContext
  emit: (event: ReviewEventBody) => void
  timeoutMs?: number
  model?: string
}

export interface ReviewHandle {
  cancel(): void
  /** Resolves after the terminal event (done / error / cancelled) has been emitted. */
  finished: Promise<void>
}

// The headless session can only read, and run the skill's fetch script plus read-only
// git/gh commands. `--tools` limits which tools exist; `dontAsk` denies anything not
// listed here instead of prompting (nobody is there to answer). Commands Claude Code
// classifies as read-only (ls, cat, wc...) are still allowed automatically.
export function allowedTools(skillDir: string): string[] {
  return [
    'Read',
    'Grep',
    'Glob',
    `Bash(bash ${fetchScriptPath(skillDir)}:*)`,
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git diff:*)',
    'Bash(git blame:*)',
    'Bash(gh pr view:*)',
    'Bash(gh pr diff:*)'
  ]
}

export function buildArgs(opts: Pick<RunOptions, 'skill' | 'model'>): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    buildSystemPrompt(opts.skill),
    '--tools',
    'Read Grep Glob Bash',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    ...(opts.model ? ['--model', opts.model] : []),
    '--allowedTools',
    ...allowedTools(opts.skill.skillDir)
  ]
}

export function runReview(opts: RunOptions): ReviewHandle {
  const { emit, workDir } = opts
  let settled = false
  let cancelled = false
  let timedOut = false
  let result: StreamResult | null = null
  let stderrTail = ''

  const child = spawn(opts.claudePath, buildArgs(opts), {
    cwd: workDir,
    env: opts.env,
    // Own process group, so cancel can kill claude and everything it spawned (bash, git...).
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  // The prompt goes over stdin: it keeps the task text out of `ps` output.
  child.stdin.on('error', () => {})
  child.stdin.end(buildPrompt(opts.input, { skillDir: opts.skill.skillDir, workDir }))

  // Raw stream kept next to the review for debugging and test fixtures.
  const raw = createWriteStream(join(workDir, 'stream.jsonl'))

  const killTree = (): void => {
    if (child.pid === undefined || child.exitCode !== null) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      return
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null) process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS).unref()
  }

  let resolveFinished!: () => void
  const finished = new Promise<void>((resolve) => (resolveFinished = resolve))

  const settle = (event: ReviewEventBody): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    raw.end()
    emit(event)
    resolveFinished()
  }

  const timer = setTimeout(() => {
    timedOut = true
    killTree()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  emit({ type: 'status', message: 'Starting Claude Code' })

  createInterface({ input: child.stdout }).on('line', (line) => {
    raw.write(line + '\n')
    for (const parsed of parseStreamLine(line, { workDir })) {
      if (parsed.kind === 'result') result = parsed.result
      else if (!settled) emit(parsed.event)
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('error', (error) => {
    settle({ type: 'error', message: `Couldn't start Claude Code: ${error.message}` })
  })

  child.on('close', (code) => {
    if (cancelled) return settle({ type: 'cancelled' })
    if (timedOut) {
      const minutes = Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60000)
      return settle({ type: 'error', message: `Review timed out after ${minutes} minutes.` })
    }
    if (result && !result.isError) {
      const extracted = extractFindings(result.text)
      return settle({
        type: 'done',
        result: {
          ...extracted,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          deniedTools: result.deniedTools
        }
      })
    }
    const detail = result?.text || stderrTail.trim() || `claude exited with code ${code}`
    settle({ type: 'error', message: `Review failed: ${detail.slice(-1000)}` })
  })

  return {
    cancel: () => {
      if (settled) return
      cancelled = true
      killTree()
    },
    finished
  }
}
