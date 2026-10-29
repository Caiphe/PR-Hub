import type { ConnectionStatus, GitHubProblem } from '../shared/github'
import { parsePrUrl } from '../shared/validate'
import { CLI_MISSING, FINE_GRAINED_STEPS, LOGIN_COMMAND, loginProblem } from './githubErrors'
import { authStatus, GhError, runGh, type AuthStatus } from './githubPoster'

// Read-only GitHub connection check. It runs `gh --version`, `gh auth status` (which prints the
// token masked; only its type prefix is parsed) and, when asked, one GET of the PR. It never
// writes to GitHub, so whether posting will be accepted is an estimate, and says so.

const CHECK_TIMEOUT_MS = 15_000

export interface CheckOptions {
  /** Path to gh, or null when it isn't installed. */
  gh: string | null
  env: NodeJS.ProcessEnv
  prUrl?: string
  timeoutMs?: number
}

type Repo = NonNullable<ConnectionStatus['repo']>

function asProblem(error: unknown, tokenKind?: AuthStatus['tokenKind']): GitHubProblem {
  if (error instanceof GhError) return error.problem('read', tokenKind)
  return {
    kind: 'unknown',
    title: 'GitHub check failed',
    message: 'PR Hub could not run the GitHub CLI.',
    actions: ['Check that `gh --version` works in a terminal.']
  }
}

export function assessPosting(
  auth: ConnectionStatus['auth'],
  repo: Repo | undefined,
  repoName: string | undefined
): ConnectionStatus['posting'] {
  if (auth.state !== 'signed_in') {
    return { state: 'unavailable', message: 'Posting to GitHub needs a working gh login.' }
  }
  if (repo?.state === 'not_readable') {
    return {
      state: 'unlikely',
      message: "This login can't read the PR, so GitHub won't accept a review from it either."
    }
  }

  const where = repoName ?? "the PR's base repository"
  const ownPr = repo?.isOwnPr
    ? ' You opened this PR, so GitHub only allows Comment, not Request changes.'
    : ''
  const unprovable = "PR Hub can't confirm that without posting."

  switch (auth.tokenKind) {
    case 'fine_grained_pat':
      return {
        state: 'unverified',
        message: `gh uses a fine-grained personal access token. GitHub accepts a review only if the token includes ${where} with Pull requests set to "Read and write". ${unprovable}${ownPr}`,
        actions: FINE_GRAINED_STEPS,
        command: LOGIN_COMMAND
      }
    case 'classic_pat':
    case 'oauth': {
      const scopes = auth.scopes
      if (!scopes) break
      const refresh = 'gh auth refresh --hostname github.com --scopes repo'
      if (scopes.includes('repo') || (scopes.includes('public_repo') && repo?.private === false)) {
        return {
          state: 'likely',
          message: `This login has the ${scopes.includes('repo') ? 'repo' : 'public_repo'} scope, so posting should work. GitHub can still refuse, for example when an organization requires SSO authorization or restricts third-party access. ${unprovable}${ownPr}`
        }
      }
      return {
        state: 'unlikely',
        message: `This login's scopes (${scopes.join(', ') || 'none'}) don't allow reviewing ${repo?.private ? 'private ' : ''}pull requests.${ownPr}`,
        actions: ['Add the repo scope with the command below, then check again.'],
        command: refresh
      }
    }
    case 'app':
      return {
        state: 'unverified',
        message: `gh uses a GitHub App token. It can post only if the app is installed on ${where} with Pull requests: Read and write. ${unprovable}${ownPr}`
      }
  }
  return {
    state: 'unverified',
    message: `PR Hub can't tell what this login is allowed to do. ${unprovable}${ownPr}`
  }
}

async function cliVersion(
  gh: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string | undefined> {
  try {
    const { stdout } = await runGh(gh, ['--version'], env, { timeoutMs })
    return /gh version (\S+)/.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

async function readPr(
  gh: string,
  env: NodeJS.ProcessEnv,
  prUrl: string,
  auth: AuthStatus,
  timeoutMs: number
): Promise<{ repo: Repo; problem?: GitHubProblem }> {
  const ref = parsePrUrl(prUrl)!
  try {
    const { stdout } = await runGh(
      gh,
      [
        'api',
        `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
        '--jq',
        '{author: .user.login, private: .base.repo.private}'
      ],
      env,
      { timeoutMs }
    )
    const pr = JSON.parse(stdout) as { author?: unknown; private?: unknown }
    const author = typeof pr.author === 'string' ? pr.author : undefined
    return {
      repo: {
        prUrl: ref.url,
        state: 'readable',
        ...(typeof pr.private === 'boolean' ? { private: pr.private } : {}),
        ...(author ? { author } : {}),
        isOwnPr: !!author && !!auth.login && author.toLowerCase() === auth.login.toLowerCase()
      }
    }
  } catch (error) {
    return {
      repo: { prUrl: ref.url, state: 'not_readable' },
      problem: asProblem(error, auth.tokenKind)
    }
  }
}

export async function checkConnection(options: CheckOptions): Promise<ConnectionStatus> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS
  const ref = options.prUrl ? parsePrUrl(options.prUrl) : null
  const skippedRepo: Repo | undefined = ref ? { prUrl: ref.url, state: 'skipped' } : undefined
  const checkedAt = Date.now()

  if (!options.gh) {
    return {
      checkedAt,
      cli: { installed: false },
      auth: { state: 'unknown' },
      ...(skippedRepo ? { repo: skippedRepo } : {}),
      posting: { state: 'unavailable', message: 'Posting to GitHub needs the GitHub CLI.' },
      problems: [CLI_MISSING]
    }
  }

  const { gh, env } = options
  const problems: GitHubProblem[] = []
  const [version, auth] = await Promise.all([
    cliVersion(gh, env, timeoutMs),
    authStatus(gh, env, timeoutMs).catch((error: unknown) => {
      problems.push(asProblem(error))
      return null
    })
  ])

  const authOut: ConnectionStatus['auth'] = auth ? { ...auth } : { state: 'unknown' }
  if (auth?.state === 'signed_out') problems.push(loginProblem('signed_out'))
  if (auth?.state === 'invalid') problems.push(loginProblem('invalid'))

  let repo = skippedRepo
  if (ref && auth?.state === 'signed_in') {
    const read = await readPr(gh, env, ref.url, auth, timeoutMs)
    repo = read.repo
    if (read.problem) problems.push(read.problem)
  }

  return {
    checkedAt,
    cli: { installed: true, ...(version ? { version } : {}) },
    auth: authOut,
    ...(repo ? { repo } : {}),
    posting: assessPosting(authOut, repo, ref ? `${ref.owner}/${ref.repo}` : undefined),
    problems
  }
}
