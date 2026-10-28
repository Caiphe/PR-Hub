import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ReviewEventBody } from '../shared/ipc'
import { childEnv } from './environment'
import { buildArgs, runReview, type RunOptions } from './reviewRunner'

const skill = { skillDir: '/skills/pr-review', skillMarkdown: '# PR Review' }

describe('buildArgs', () => {
  it('restricts tools and never prompts for permission', () => {
    const args = buildArgs({ skill })
    expect(args).toContain('-p')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read Grep Glob Bash')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('grants no allow rules: an explicit Read rule would open the whole disk', () => {
    expect(buildArgs({ skill, model: 'sonnet' })).not.toContain('--allowedTools')
    expect(buildArgs({ skill, model: 'sonnet' }).slice(-2)).toEqual(['--model', 'sonnet'])
  })
})

describe('childEnv', () => {
  it('drops nested-session and Electron variables and sets PATH', () => {
    const env = childEnv(
      {
        HOME: '/Users/me',
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'x',
        CLAUDE_CODE_OAUTH_TOKEN: 'keep-me'
      },
      '/opt/homebrew/bin:/usr/bin'
    )
    expect(env).toEqual({
      HOME: '/Users/me',
      PATH: '/opt/homebrew/bin:/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep-me'
    })
  })
})

// Lifecycle tests with stand-in executables: a fake skill whose fetch script and a fake
// `claude` are small shell scripts, so cancel/timeout/failure paths run for real.
describe('runReview lifecycle', () => {
  const RESULT = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '## PR review: x\n\n```json\n{"verdict":"approve"}\n```',
    total_cost_usd: 0.01,
    duration_ms: 5
  })

  function setup(
    fetchBody: string,
    claudeBody: string
  ): RunOptions & { events: ReviewEventBody[] } {
    // A space in the path on purpose: the real data folder is "Application Support/PR Hub".
    const root = mkdtempSync(join(tmpdir(), 'pr hub-'))
    const skillDir = join(root, 'skill')
    mkdirSync(join(skillDir, 'scripts'), { recursive: true })
    writeFileSync(join(skillDir, 'scripts/fetch_pr.sh'), fetchBody)
    const claudePath = join(root, 'claude')
    writeFileSync(claudePath, `#!/bin/sh\n${claudeBody}\n`)
    chmodSync(claudePath, 0o755)
    const workDir = join(root, 'work dir')
    mkdirSync(workDir)
    const events: ReviewEventBody[] = []
    return {
      events,
      input: { title: 'T', prUrl: 'https://github.com/o/r/pull/1', description: 'D' },
      workDir,
      claudePath,
      env: process.env,
      skill: { skillDir, skillMarkdown: '# skill' },
      emit: (e) => events.push(e)
    }
  }
  const terminal = (events: ReviewEventBody[]): ReviewEventBody[] =>
    events.filter((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')

  it('fetches with exact arguments (paths with spaces intact), then reviews', async () => {
    const opts = setup(
      'printf "%s\\n" "$@" > "$2.args"; mkdir -p "$2"; echo fetched-ok',
      `cat > /dev/null; printf '%s\\n' '${RESULT}'`
    )
    const handle = runReview(opts)
    await handle.finished
    expect(terminal(opts.events)).toEqual([expect.objectContaining({ type: 'done' })])
    expect(readFileSync(join(opts.workDir, 'pr.args'), 'utf8').trim().split('\n')).toEqual([
      'https://github.com/o/r/pull/1',
      join(opts.workDir, 'pr')
    ])
    expect(opts.events.slice(0, 2)).toEqual([
      { type: 'status', message: 'Fetching the PR' },
      { type: 'status', message: 'Starting Claude Code' }
    ])
  })

  it('fails without starting Claude when the fetch fails', async () => {
    const opts = setup('echo "ERROR: git fetch failed" >&2; exit 1', 'touch "$PWD/claude-ran"')
    await runReview(opts).finished
    const [end] = terminal(opts.events)
    expect(end).toMatchObject({
      type: 'error',
      message: expect.stringContaining('git fetch failed')
    })
    expect(() => readFileSync(join(opts.workDir, 'claude-ran'))).toThrow()
  })

  it('cancels during the fetch with exactly one cancelled event', async () => {
    const opts = setup('sleep 30', 'echo never')
    const handle = runReview(opts)
    await new Promise((r) => setTimeout(r, 200))
    handle.cancel()
    await handle.finished
    expect(terminal(opts.events)).toEqual([{ type: 'cancelled' }])
  })

  it('cancels during the review and kills the whole process group', async () => {
    const opts = setup('exit 0', 'sleep 30 & echo $! > "$PWD/child.pid"; wait')
    const handle = runReview(opts)
    const pidFile = join(opts.workDir, 'child.pid')
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50))
    handle.cancel()
    await handle.finished
    expect(terminal(opts.events)).toEqual([{ type: 'cancelled' }])
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('times out', async () => {
    const opts = { ...setup('exit 0', 'sleep 30'), timeoutMs: 300 }
    await runReview(opts).finished
    expect(terminal(opts.events)).toEqual([
      { type: 'error', message: expect.stringMatching(/timed out/) }
    ])
  })

  it('reports a missing claude binary once', async () => {
    const opts = { ...setup('exit 0', ''), claudePath: '/nonexistent/claude' }
    await runReview(opts).finished
    await new Promise((r) => setTimeout(r, 50))
    expect(terminal(opts.events)).toEqual([
      { type: 'error', message: expect.stringContaining("Couldn't start Claude Code") }
    ])
  })

  it('includes stderr when claude exits without a result', async () => {
    const opts = setup('exit 0', 'cat > /dev/null; echo "boom: auth expired" >&2; exit 3')
    await runReview(opts).finished
    expect(terminal(opts.events)).toEqual([
      { type: 'error', message: expect.stringContaining('boom: auth expired') }
    ])
  })
})
