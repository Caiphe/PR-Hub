import type { ConnectionStatus, TokenKind } from '@shared/github'
import { parsePrUrl } from '@shared/validate'

// Pure display logic for the GitHub connection control, kept out of the component so it can
// be tested without a DOM.

export type StatusView =
  | { kind: 'checking' }
  | { kind: 'ready'; status: ConnectionStatus }
  | { kind: 'failed'; message: string }

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted'

export function statusChip(view: StatusView): { label: string; tone: Tone } {
  if (view.kind === 'checking') return { label: 'Checking GitHub…', tone: 'muted' }
  if (view.kind === 'failed') return { label: 'GitHub check failed', tone: 'warn' }
  const { status } = view
  // gh is optional (public PRs work without it), so a missing CLI or login isn't an alarm.
  if (!status.cli.installed) return { label: 'GitHub CLI unavailable', tone: 'muted' }
  if (status.auth.state === 'signed_out') return { label: 'Not signed in to GitHub', tone: 'muted' }
  if (status.problems.length > 0 || status.posting.state === 'unlikely') {
    return { label: 'Action needed', tone: 'warn' }
  }
  if (status.auth.state === 'signed_in' && status.auth.login) {
    return { label: `Connected as @${status.auth.login}`, tone: 'good' }
  }
  return { label: 'GitHub status unknown', tone: 'muted' }
}

export const POSTING_LABELS: Record<ConnectionStatus['posting']['state'], string> = {
  likely: 'Should work',
  unverified: "Can't be confirmed without posting",
  unlikely: 'Likely to fail',
  unavailable: 'Not available'
}

export const POSTING_TONES: Record<ConnectionStatus['posting']['state'], Tone> = {
  likely: 'good',
  unverified: 'info',
  unlikely: 'warn',
  unavailable: 'muted'
}

const TOKEN_LABELS: Record<TokenKind, string> = {
  oauth: 'browser login',
  classic_pat: 'classic token',
  fine_grained_pat: 'fine-grained token',
  app: 'GitHub App token',
  unknown: 'token'
}

export function accountLine(auth: ConnectionStatus['auth']): string {
  if (auth.state === 'signed_out') return 'Not signed in'
  if (auth.state === 'unknown') return 'Unknown'
  const parts = [auth.login ? `@${auth.login}` : 'Signed in']
  if (auth.state === 'invalid') parts.push('login no longer valid')
  if (auth.tokenKind) parts.push(TOKEN_LABELS[auth.tokenKind])
  if (auth.source === 'GH_TOKEN' || auth.source === 'GITHUB_TOKEN')
    parts.push(`from ${auth.source}`)
  return parts.join(' · ')
}

/** The repository result, but only if it is for the link currently in the form. */
export function repoFor(
  status: ConnectionStatus | null,
  prUrl: string
): ConnectionStatus['repo'] | undefined {
  const current = parsePrUrl(prUrl)?.url
  return current && status?.repo?.prUrl === current ? status.repo : undefined
}

export function repoLine(repo: ConnectionStatus['repo'] | undefined): string {
  if (!repo) return 'Not checked'
  if (repo.state === 'skipped') return 'Not checked (needs a gh login)'
  if (repo.state === 'not_readable') return "Can't read this PR"
  const visibility = repo.private === undefined ? '' : repo.private ? ' · private' : ' · public'
  return `Readable${visibility}${repo.isOwnPr ? ' · your PR' : ''}`
}
