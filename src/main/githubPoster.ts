import { execFile } from 'child_process'
import type { GitHubProblem, TokenKind } from '../shared/github'
import type { PrRef } from '../shared/validate'
import { findOnPath } from './environment'
import {
  CLI_MISSING,
  classifyGhFailure,
  describeGhOutput,
  needsAuthFix,
  redactSecrets,
  type GhOperation
} from './githubErrors'
import type { PrFile, ReviewPayload } from './githubReview'

// Talks to GitHub through the user's `gh` CLI, so the app never handles tokens.
// PR_HUB_GH points at a different binary (used by tests to stand in for GitHub).

export class GhError extends Error {
  constructor(
    message: string,
    readonly needsAuth = false,
    /** Redacted stderr plus the API's error body, for classifyGhFailure(). */
    readonly raw = message,
    readonly timedOut = false
  ) {
    super(message)
  }

  /** Specific guidance for this failure; reading and posting are explained differently. */
  problem(operation: GhOperation, tokenKind?: TokenKind): GitHubProblem {
    return classifyGhFailure(this.raw, { operation, timedOut: this.timedOut, tokenKind })
  }
}

class GhMissingError extends GhError {
  override problem(): GitHubProblem {
    return CLI_MISSING
  }
}

interface GhResult {
  stdout: string
  stderr: string
}

export async function resolveGh(env: NodeJS.ProcessEnv): Promise<string> {
  const path = await findGh(env)
  if (!path) {
    throw new GhMissingError(
      'GitHub CLI (gh) not found. Install it from https://cli.github.com, then run `gh auth login`.'
    )
  }
  return path
}

/** Like resolveGh, but "not installed" is an answer rather than an error. */
export async function findGh(env: NodeJS.ProcessEnv): Promise<string | null> {
  return process.env.PR_HUB_GH || (await findOnPath('gh', env.PATH ?? ''))
}

/**
 * How long a gh call may take before it's killed. Posting has its own limit: a post that runs
 * out of time has an unclear outcome. Tests shorten it to simulate a slow GitHub.
 */
export const GH_TIMEOUTS = { defaultMs: 60_000, postMs: 60_000 }

export function runGh(
  gh: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { input?: string; timeoutMs?: number } = {}
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gh,
      args,
      {
        env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        timeout: options.timeoutMs ?? GH_TIMEOUTS.defaultMs,
        maxBuffer: 50 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const raw = redactSecrets(describeGhOutput(stderr || error.message, stdout))
          return reject(toGhError(raw, Boolean(error.killed)))
        }
        resolve({ stdout, stderr })
      }
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

function toGhError(raw: string, timedOut: boolean): GhError {
  const problem = classifyGhFailure(raw, { operation: 'read', timedOut })
  if (needsAuthFix(problem)) {
    return new GhError(
      'GitHub CLI is not logged in. Run `gh auth login` in a terminal, then try again.',
      true,
      raw,
      timedOut
    )
  }
  // gh api prints e.g. "gh: Unprocessable Entity (HTTP 422)" plus the JSON message.
  return new GhError(
    `GitHub: ${raw.split('\n').slice(0, 6).join(' ').slice(0, 600)}`,
    false,
    raw,
    timedOut
  )
}

export interface AuthStatus {
  state: 'signed_in' | 'signed_out' | 'invalid'
  login?: string
  tokenKind?: TokenKind
  scopes?: string[]
  source?: 'keyring' | 'config' | 'GH_TOKEN' | 'GITHUB_TOKEN'
}

/** Only the token's type prefix is looked at; gh prints the token itself masked anyway. */
export function tokenKindOf(prefix: string): TokenKind {
  if (prefix.startsWith('github_pat_')) return 'fine_grained_pat'
  if (prefix.startsWith('ghp_')) return 'classic_pat'
  if (prefix.startsWith('gho_') || prefix.startsWith('ghu_')) return 'oauth'
  if (prefix.startsWith('ghs_')) return 'app'
  return 'unknown'
}

/**
 * Parses `gh auth status --hostname github.com` (stdout or stderr, depending on gh version).
 * With several accounts, the one marked "Active account: true" wins. Nothing token-like is kept.
 */
export function parseAuthStatus(output: string): AuthStatus {
  const blocks: AuthStatus[] = []
  let active: AuthStatus | null = null
  for (const line of output.split('\n')) {
    const account =
      /Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)(?: \(([^)]*)\))?/.exec(line) ?? null
    const failed = /Failed to log in to \S+(?: account ([A-Za-z0-9-]+))?(?: \(([^)]*)\))?/.exec(
      line
    )
    if (account || failed) {
      const match = (account ?? failed)!
      const where = match[2] ?? ''
      const block: AuthStatus = {
        state: account ? 'signed_in' : 'invalid',
        ...(match[1] ? { login: match[1] } : {}),
        source: /^(GH_TOKEN|GITHUB_TOKEN)$/.test(where)
          ? (where as 'GH_TOKEN' | 'GITHUB_TOKEN')
          : where === 'keyring'
            ? 'keyring'
            : 'config'
      }
      blocks.push(block)
      continue
    }
    const current = blocks[blocks.length - 1]
    if (!current) continue
    if (/Active account:\s*true/i.test(line)) active = current
    const token = /Token:\s*(github_pat_|gh[a-z]_)/.exec(line)
    if (token) current.tokenKind = tokenKindOf(token[1])
    const scopes = /Token scopes:\s*(.*)$/.exec(line)
    if (scopes) {
      current.scopes = scopes[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s && s !== 'none')
    }
  }
  return (
    active ?? blocks.find((b) => b.state === 'signed_in') ?? blocks[0] ?? { state: 'signed_out' }
  )
}

/** gh auth status, which exits non-zero when signed out or when a login is invalid. */
export async function authStatus(
  gh: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number
): Promise<AuthStatus> {
  try {
    const { stdout, stderr } = await runGh(
      gh,
      ['auth', 'status', '--hostname', 'github.com'],
      env,
      {
        timeoutMs
      }
    )
    return parseAuthStatus(`${stdout}\n${stderr}`)
  } catch (error) {
    if (!(error instanceof GhError)) throw error
    const parsed = parseAuthStatus(error.raw)
    if (parsed.login || parsed.state === 'invalid') return { ...parsed, state: 'invalid' }
    // Network trouble isn't a login problem; let the caller explain it as itself.
    if (!error.needsAuth) throw error
    return { state: 'signed_out' }
  }
}

export interface Account {
  login: string
  tokenKind?: TokenKind
}

/** Login of the authenticated gh user; throws a needsAuth GhError if not logged in. */
export async function ghAccount(gh: string, env: NodeJS.ProcessEnv): Promise<Account> {
  // toGhError already marks auth problems as needsAuth; anything else (network down,
  // GitHub 5xx) is passed through so the user isn't sent to re-authenticate for nothing.
  const { stdout, stderr } = await runGh(gh, ['auth', 'status', '--hostname', 'github.com'], env)
  const status = parseAuthStatus(`${stdout}\n${stderr}`)
  const login = (await runGh(gh, ['api', 'user', '--jq', '.login'], env)).stdout.trim()
  return status.tokenKind ? { login, tokenKind: status.tokenKind } : { login }
}

export interface PrState {
  headSha: string
  /** Login of the PR's author (GitHub refuses "request changes" from them). */
  author: string | null
  files: PrFile[]
}

export async function fetchPrState(
  gh: string,
  ref: PrRef,
  env: NodeJS.ProcessEnv
): Promise<PrState> {
  const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
  const [pull, files] = await Promise.all([
    runGh(gh, ['api', base, '--jq', '{sha: .head.sha, author: .user.login}'], env),
    // One compact JSON object per line, so pagination needs no array merging.
    runGh(gh, ['api', '--paginate', `${base}/files`, '--jq', '.[] | {filename, patch}'], env)
  ])
  const head = JSON.parse(pull.stdout) as { sha?: unknown; author?: unknown }
  if (typeof head.sha !== 'string' || !/^[0-9a-f]{40}$/.test(head.sha)) {
    throw new GhError("GitHub didn't return the PR's head commit.")
  }
  return {
    headSha: head.sha,
    author: typeof head.author === 'string' ? head.author : null,
    files: files.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PrFile)
  }
}

// GitHub's compare API lists at most 300 files; a list that long may be incomplete.
const COMPARE_FILE_LIMIT = 300

/**
 * Files that differ between two commits, or null when that can't be known (the old commit is
 * gone after a force-push, or the list may be cut off). Read-only.
 */
export async function changedFilesBetween(
  gh: string,
  ref: PrRef,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv
): Promise<Set<string> | null> {
  try {
    const { stdout } = await runGh(
      gh,
      [
        'api',
        `repos/${ref.owner}/${ref.repo}/compare/${base}...${head}`,
        '--jq',
        '[.files[] | .filename, (.previous_filename // empty)]'
      ],
      env
    )
    const files = JSON.parse(stdout) as unknown
    if (!Array.isArray(files) || files.length >= COMPARE_FILE_LIMIT) return null
    return new Set(files.filter((f): f is string => typeof f === 'string'))
  } catch {
    return null
  }
}

/**
 * The URL of the review on this PR that carries the submission marker, or null if none does.
 * Read-only; throws if the reviews can't be listed (the caller then can't rule out a post).
 */
export async function findSubmittedReview(
  gh: string,
  ref: PrRef,
  marker: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const { stdout } = await runGh(
    gh,
    [
      'api',
      '--paginate',
      `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
      '--jq',
      '.[] | {html_url, body}'
    ],
    env
  )
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const review = JSON.parse(line) as { html_url?: unknown; body?: unknown }
    if (typeof review.body === 'string' && review.body.includes(marker)) {
      return typeof review.html_url === 'string' ? review.html_url : ref.url
    }
  }
  return null
}

/** Creates the review and returns its URL. */
export async function submitReview(
  gh: string,
  ref: PrRef,
  payload: ReviewPayload,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await runGh(
    gh,
    [
      'api',
      '--method',
      'POST',
      `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
      '--input',
      '-'
    ],
    env,
    { input: JSON.stringify(payload), timeoutMs: GH_TIMEOUTS.postMs }
  )
  const created = JSON.parse(stdout) as { html_url?: string }
  return created.html_url ?? ref.url
}
