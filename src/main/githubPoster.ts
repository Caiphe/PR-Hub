import { execFile } from 'child_process'
import type { PrRef } from '../shared/validate'
import { findOnPath } from './environment'
import type { PrFile, ReviewPayload } from './githubReview'

// Talks to GitHub through the user's `gh` CLI, so the app never handles tokens.
// PR_HUB_GH points at a different binary (used by tests to stand in for GitHub).

export class GhError extends Error {
  constructor(
    message: string,
    readonly needsAuth = false
  ) {
    super(message)
  }
}

interface GhResult {
  stdout: string
  stderr: string
}

export async function resolveGh(env: NodeJS.ProcessEnv): Promise<string> {
  const path = process.env.PR_HUB_GH || (await findOnPath('gh', env.PATH ?? ''))
  if (!path) {
    throw new GhError(
      'GitHub CLI (gh) not found. Install it from https://cli.github.com, then run `gh auth login`.'
    )
  }
  return path
}

function runGh(
  gh: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gh,
      args,
      {
        env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        timeout: 60_000,
        maxBuffer: 50 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) return reject(toGhError(stderr || error.message))
        resolve({ stdout, stderr })
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

function toGhError(stderr: string): GhError {
  const text = stderr.trim()
  if (/auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(text)) {
    return new GhError(
      'GitHub CLI is not logged in. Run `gh auth login` in a terminal, then try again.',
      true
    )
  }
  // gh api prints e.g. "gh: Unprocessable Entity (HTTP 422)" plus the JSON message.
  return new GhError(`GitHub: ${text.split('\n').slice(0, 6).join(' ').slice(0, 600)}`)
}

/** Login of the authenticated gh user; throws a needsAuth GhError if not logged in. */
export async function ghAccount(gh: string, env: NodeJS.ProcessEnv): Promise<string> {
  // toGhError already marks auth problems as needsAuth; anything else (network down,
  // GitHub 5xx) is passed through so the user isn't sent to re-authenticate for nothing.
  await runGh(gh, ['auth', 'status', '--hostname', 'github.com'], env)
  return (await runGh(gh, ['api', 'user', '--jq', '.login'], env)).stdout.trim()
}

export interface PrState {
  headSha: string
  files: PrFile[]
}

export async function fetchPrState(
  gh: string,
  ref: PrRef,
  env: NodeJS.ProcessEnv
): Promise<PrState> {
  const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
  const [pull, files] = await Promise.all([
    runGh(gh, ['api', base, '--jq', '.head.sha'], env),
    // One compact JSON object per line, so pagination needs no array merging.
    runGh(gh, ['api', '--paginate', `${base}/files`, '--jq', '.[] | {filename, patch}'], env)
  ])
  return {
    headSha: pull.stdout.trim(),
    files: files.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PrFile)
  }
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
    JSON.stringify(payload)
  )
  const created = JSON.parse(stdout) as { html_url?: string }
  return created.html_url ?? ref.url
}
