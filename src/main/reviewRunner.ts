import { spawn, type ChildProcess } from 'child_process'
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

/** Where the skill's fetch script puts the PR, relative to the work dir. */
export const PR_DIR = 'pr'

// The headless session only reads files under its work dir. `--tools` limits which tools
// exist, and `dontAsk` denies anything that isn't allowed without asking. There are no allow
// rules on purpose: Read/Grep/Glob are already allowed inside the cwd, and an explicit
// "Read" rule would extend that to the whole disk. Bash is left to Claude Code's built-in
// read-only commands (still cwd-bound). The PR is fetched by the app beforehand, so the
// model never chooses arguments for a script or git command.
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
    ...(opts.model ? ['--model', opts.model] : [])
  ]
}

export function doneEvent(result: StreamResult): ReviewEventBody {
  return {
    type: 'done',
    result: {
      ...extractFindings(result.text),
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      deniedTools: result.deniedTools
    }
  }
}

export function runReview(opts: RunOptions): ReviewHandle {
  const { emit, workDir } = opts
  let settled = false
  let cancelled = false
  let timedOut = false
  let current: ChildProcess | null = null

  let resolveFinished!: () => void
  const finished = new Promise<void>((resolve) => (resolveFinished = resolve))

  // Raw stream kept next to the review for debugging and test fixtures.
  const raw = createWriteStream(join(workDir, 'stream.jsonl'))

  const settle = (event: ReviewEventBody): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    raw.end()
    emit(event)
    resolveFinished()
  }

  // Each child runs in its own process group, so cancel/timeout also stop whatever it
  // spawned (git, python, bash). Signals go to the group even if the leader has exited,
  // since a grandchild can still hold stdout open.
  const killTree = (child: ChildProcess | null): void => {
    const pid = child?.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      return // Group already gone.
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS).unref()
  }

  const stopReason = (): ReviewEventBody | null => {
    if (cancelled) return { type: 'cancelled' }
    if (timedOut) {
      const minutes = Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60000)
      return { type: 'error', message: `Review timed out after ${minutes} minutes.` }
    }
    return null
  }

  const timer = setTimeout(() => {
    timedOut = true
    killTree(current)
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const fetchPr = (): Promise<{ ok: boolean; output: string }> =>
    new Promise((resolve) => {
      // Arguments are passed as an array (no shell), with a URL validated upstream and a
      // fixed destination, so paths with spaces work and nothing is model-controlled.
      const child = spawn(
        'bash',
        [fetchScriptPath(opts.skill.skillDir), opts.input.prUrl, join(workDir, PR_DIR)],
        { cwd: workDir, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      current = child
      let output = ''
      const collect = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-8000)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('error', (error) => resolve({ ok: false, output: error.message }))
      child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }))
    })

  const runClaude = (fetchLog: string): void => {
    let result: StreamResult | null = null
    let stderrTail = ''
    const child = spawn(opts.claudePath, buildArgs(opts), {
      cwd: workDir,
      env: opts.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    current = child

    // The prompt goes over stdin: it keeps the task text out of `ps` output.
    child.stdin.on('error', () => {})
    child.stdin.end(buildPrompt(opts.input, { workDir, fetchLog }))

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
      const stopped = stopReason()
      if (stopped) return settle(stopped)
      if (result && !result.isError) return settle(doneEvent(result))
      const detail = result?.text || stderrTail.trim() || `claude exited with code ${code}`
      settle({ type: 'error', message: `Review failed: ${detail.slice(-1000)}` })
    })
  }

  const start = async (): Promise<void> => {
    emit({ type: 'status', message: 'Fetching the PR' })
    const fetched = await fetchPr()
    const stopped = stopReason()
    if (stopped) return settle(stopped)
    if (!fetched.ok) {
      return settle({
        type: 'error',
        message: `Couldn't fetch the PR (private repo, wrong link, or no network?). For private repos, run \`gh auth login\`.\n\n${fetched.output.slice(-1500)}`
      })
    }
    emit({ type: 'status', message: 'Starting Claude Code' })
    runClaude(fetched.output)
  }

  start().catch((error) => settle({ type: 'error', message: `Review failed: ${error.message}` }))

  return {
    cancel: () => {
      if (settled) return
      cancelled = true
      killTree(current)
    },
    finished
  }
}
