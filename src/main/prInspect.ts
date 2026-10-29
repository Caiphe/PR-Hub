import { z } from 'zod'
import type {
  GitHubProblem,
  InspectIssueResult,
  InspectPrResult,
  IssueDetails,
  LinkedIssue,
  PrMetadata
} from '../shared/github'
import { LIMITS, OWNER, REPO, validRef, type IssueRef, type PrRef } from '../shared/validate'
import { classifyGhFailure } from './githubErrors'
import { GhError, runGh } from './githubPoster'

// Read-only PR and issue metadata for the intake form. Uses gh when it's installed and signed
// in (private repositories work); otherwise GitHub's public API without credentials, so public
// PRs can be inspected with no login at all. Everything returned is untrusted author text:
// cleaned of control characters, capped in size, and only ever displayed or copied as text.

const TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 2 * 60 * 1000
const CACHE_MAX = 30
const TITLE_MAX = 300
const MAX_LINKED = 5

export interface InspectDeps {
  /** Path to gh, or null when it isn't installed. */
  gh: string | null
  env: NodeJS.ProcessEnv
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
}

// Bidirectional-override and other control characters can make displayed text differ from
// what it says ("Trojan Source"); newlines and tabs are kept.
function isUnsafeChar(ch: string): boolean {
  const c = ch.codePointAt(0)!
  if (c === 0x0a || c === 0x09) return false
  return (
    c < 0x20 ||
    c === 0x7f ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  )
}

export function cleanText(raw: string | null | undefined, max: number): [string, boolean] {
  const text = Array.from((raw ?? '').replace(/\r\n?/g, '\n'))
    .filter((ch) => !isUnsafeChar(ch))
    .join('')
    .trim()
  return text.length > max ? [text.slice(0, max).trimEnd(), true] : [text, false]
}

const CLOSING = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?\\s+(?:(${OWNER})/(${REPO})#(\\d+)|#(\\d+)|https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/issues/(\\d+))`,
  'gi'
)
const ISSUE_LINK = new RegExp(
  `https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/issues/(\\d+)`,
  'g'
)

/**
 * Issues a PR body points at: GitHub's closing keywords ("Fixes #12", "closes acme/web#3",
 * "Resolves https://github.com/…/issues/4") and plain issue links. Text in HTML comments and
 * code is ignored, since PR templates often contain "Fixes #(issue)" placeholders there.
 */
export function linkedIssues(body: string, base: { owner: string; repo: string }): LinkedIssue[] {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  const found = new Map<string, LinkedIssue>()
  const add = (
    owner: string,
    repo: string,
    num: string,
    relation: LinkedIssue['relation']
  ): void => {
    const number = validRef(owner, repo, num)
    if (number === null) return
    const url = `https://github.com/${owner}/${repo}/issues/${number}`
    const key = url.toLowerCase()
    if (!found.has(key)) found.set(key, { owner, repo, number, url, relation })
  }
  for (const m of text.matchAll(CLOSING)) {
    if (m[3]) add(m[1], m[2], m[3], 'closes')
    else if (m[4]) add(base.owner, base.repo, m[4], 'closes')
    else add(m[5], m[6], m[7], 'closes')
  }
  for (const m of text.matchAll(ISSUE_LINK)) add(m[1], m[2], m[3], 'mentions')
  return [...found.values()].slice(0, MAX_LINKED)
}

const PullSchema = z.object({
  title: z.string(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
  draft: z.boolean().optional(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable().optional(),
  base: z.object({ ref: z.string() }),
  head: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    label: z.string().optional(),
    repo: z.object({ full_name: z.string() }).nullable().optional()
  }),
  changed_files: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional()
})

const IssueSchema = z.object({
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']),
  pull_request: z.unknown().optional()
})

class InspectError extends Error {
  constructor(
    message: string,
    readonly problem?: GitHubProblem
  ) {
    super(message)
  }
}

async function publicApi(path: string, deps: InspectDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`https://api.github.com/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PR-Hub' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS)
    })
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } }
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    const raw = `${err.message} ${err.cause?.code ?? ''}`.trim()
    throw new InspectError(raw, classifyGhFailure(raw, { operation: 'read', timedOut }))
  }
  if (res.ok) return res.json()
  const body = (await res.json().catch(() => ({}))) as { message?: unknown }
  const message = typeof body.message === 'string' ? body.message : res.statusText
  const raw = `GitHub API: ${message} (HTTP ${res.status})`
  const problem = classifyGhFailure(raw, { operation: 'read' })
  if (problem.kind === 'not_found') {
    // Without a login GitHub hides private repositories behind a 404.
    problem.actions = [
      ...problem.actions,
      'PR Hub read this without a GitHub login. If the repository is private, sign in with `gh auth login`.'
    ]
  }
  throw new InspectError(raw, problem)
}

/** GET a GitHub API path through gh, or anonymously when gh is missing or signed out. */
async function getJson(path: string, deps: InspectDeps): Promise<[unknown, PrMetadata['via']]> {
  if (deps.gh) {
    try {
      const { stdout } = await runGh(deps.gh, ['api', path], deps.env, {
        timeoutMs: deps.timeoutMs ?? TIMEOUT_MS
      })
      return [JSON.parse(stdout), 'gh']
    } catch (error) {
      if (!(error instanceof GhError)) throw error
      const problem = error.problem('read')
      // A missing or broken login shouldn't stop reading a public PR.
      if (problem.kind !== 'signed_out' && problem.kind !== 'invalid_login') {
        throw new InspectError(error.message, problem)
      }
    }
  }
  return [await publicApi(path, deps), 'public_api']
}

function failure(error: unknown): { ok: false; error: string; problem?: GitHubProblem } {
  if (error instanceof InspectError) {
    return { ok: false, error: error.problem?.title ?? error.message, problem: error.problem }
  }
  return { ok: false, error: (error as Error).message }
}

export function toMetadata(ref: PrRef, data: unknown, via: PrMetadata['via']): PrMetadata {
  const parsed = PullSchema.safeParse(data)
  if (!parsed.success) throw new InspectError("GitHub returned PR data PR Hub doesn't understand.")
  const pr = parsed.data
  const [title] = cleanText(pr.title, TITLE_MAX)
  const [body, bodyTruncated] = cleanText(pr.body, LIMITS.description)
  const fork =
    pr.head.repo &&
    pr.head.repo.full_name.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()
  const [headLabel] = cleanText(fork && pr.head.label ? pr.head.label : pr.head.ref, 200)
  return {
    url: ref.url,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title,
    body,
    bodyTruncated,
    author: pr.user?.login ?? null,
    draft: pr.draft ?? false,
    state: pr.merged_at ? 'merged' : pr.state,
    baseRef: cleanText(pr.base.ref, 200)[0],
    headLabel,
    headSha: pr.head.sha,
    changedFiles: pr.changed_files ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    linkedIssues: linkedIssues(body, ref),
    via
  }
}

interface Cached<T> {
  expiresAt: number
  value: T
}
const prCache = new Map<string, Cached<PrMetadata>>()
const issueCache = new Map<string, Cached<IssueDetails>>()

function fromCache<T>(cache: Map<string, Cached<T>>, key: string): T | undefined {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  cache.delete(key)
  return undefined
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value })
}

export function clearInspectCache(): void {
  prCache.clear()
  issueCache.clear()
}

export async function inspectPr(ref: PrRef, deps: InspectDeps): Promise<InspectPrResult> {
  const key = ref.url.toLowerCase()
  const cached = fromCache(prCache, key)
  if (cached) return { ok: true, pr: cached }
  try {
    const [data, via] = await getJson(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, deps)
    const pr = toMetadata(ref, data, via)
    remember(prCache, key, pr)
    return { ok: true, pr }
  } catch (error) {
    return failure(error)
  }
}

export async function inspectIssue(ref: IssueRef, deps: InspectDeps): Promise<InspectIssueResult> {
  const key = ref.url.toLowerCase()
  const cached = fromCache(issueCache, key)
  if (cached) return { ok: true, issue: cached }
  try {
    const [data] = await getJson(`repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, deps)
    const parsed = IssueSchema.safeParse(data)
    if (!parsed.success)
      throw new InspectError("GitHub returned issue data PR Hub doesn't understand.")
    // GitHub's issues API also answers for pull requests.
    if (parsed.data.pull_request) {
      throw new InspectError(`#${ref.number} is a pull request, not an issue.`)
    }
    const [title] = cleanText(parsed.data.title, TITLE_MAX)
    const [body, bodyTruncated] = cleanText(parsed.data.body, LIMITS.description)
    const issue: IssueDetails = {
      url: ref.url,
      number: ref.number,
      title,
      body,
      bodyTruncated,
      state: parsed.data.state
    }
    remember(issueCache, key, issue)
    return { ok: true, issue }
  } catch (error) {
    return failure(error)
  }
}
