import { describe, expect, it } from 'vitest'
import {
  classifyGhFailure,
  conciseDetail,
  describeGhOutput,
  postFailureKind,
  redactSecrets,
  type FailureContext
} from './githubErrors'

const read: FailureContext = { operation: 'read' }
const post: FailureContext = { operation: 'post' }
const kind = (raw: string, ctx = read): string => classifyGhFailure(raw, ctx).kind

// Representative stderr from gh 2.x (plus the JSON body gh prints on stdout, where relevant).
describe('classifyGhFailure', () => {
  it('recognizes an invalid or expired login (401)', () => {
    expect(kind('gh: Bad credentials (HTTP 401)\nTry authenticating with:  gh auth login')).toBe(
      'invalid_login'
    )
    expect(
      kind(
        'X Failed to log in to github.com account octocat (keyring)\n- The token in keyring is invalid.'
      )
    ).toBe('invalid_login')
    expect(kind('gh: Requires authentication (HTTP 401)')).toBe('invalid_login')
  })

  it('recognizes a missing login', () => {
    expect(kind('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toBe(
      'signed_out'
    )
    expect(
      kind(
        'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.'
      )
    ).toBe('signed_out')
  })

  it('splits the fine-grained token 403 by what was being done', () => {
    const raw = 'gh: Resource not accessible by personal access token (HTTP 403)'
    expect(kind(raw, read)).toBe('fine_grained_repo_access')
    const posting = classifyGhFailure(raw, post)
    expect(posting.kind).toBe('pull_requests_permission')
    expect(posting.actions.join(' ')).toMatch(/Pull requests to "Read and write"/)
    expect(posting.actions.join(' ')).toMatch(/base repository/)
    expect(posting.command).toMatch(/^gh auth login/)
  })

  it('recognizes other 403s as a permission problem', () => {
    expect(kind('gh: Resource not accessible by integration (HTTP 403)', post)).toBe('permission')
    expect(kind('gh: Must have push access to repository (HTTP 403)', post)).toBe('permission')
  })

  it('recognizes organization approval and SSO', () => {
    expect(
      kind(
        'gh: Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. (HTTP 403)'
      )
    ).toBe('org_approval')
    expect(
      kind(
        "gh: The 'acme' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days. (HTTP 403)"
      )
    ).toBe('org_approval')
    expect(
      kind(
        'gh: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization. (HTTP 403)'
      )
    ).toBe('sso_required')
  })

  it('recognizes primary and secondary rate limits', () => {
    expect(kind('gh: API rate limit exceeded for user ID 1. (HTTP 403)')).toBe('rate_limited')
    expect(kind('gh: You have exceeded a secondary rate limit. (HTTP 403)')).toBe('rate_limited')
    expect(kind('gh: Too Many Requests (HTTP 429)')).toBe('rate_limited')
  })

  it('recognizes network failures and timeouts', () => {
    expect(
      kind(
        'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'
      )
    ).toBe('network')
    expect(
      kind('Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host')
    ).toBe('network')
    expect(kind('net/http: TLS handshake timeout')).toBe('network')
    expect(kind('', { operation: 'read', timedOut: true })).toBe('timeout')
  })

  it('warns that a timed-out post may have gone through', () => {
    const p = classifyGhFailure('', { operation: 'post', timedOut: true })
    expect(p.message).toMatch(/may or may not have been posted/)
    expect(p.actions.join(' ')).toMatch(/before posting again/)
  })

  it('recognizes 404s, with a hint for fine-grained tokens', () => {
    expect(kind('gh: Not Found (HTTP 404)')).toBe('not_found')
    const p = classifyGhFailure('gh: Not Found (HTTP 404)', {
      operation: 'read',
      tokenKind: 'fine_grained_pat'
    })
    expect(p.message).toMatch(/fine-grained token doesn't include it/)
  })

  it('recognizes 422s: own PR, stale positions, and other validation errors', () => {
    expect(
      kind(
        'gh: Unprocessable Entity (HTTP 422)\nReview Can not request changes on your own pull request',
        post
      )
    ).toBe('own_pr_request_changes')
    expect(
      kind(
        'gh: Unprocessable Entity (HTTP 422)\nPull request review thread line must be part of the diff',
        post
      )
    ).toBe('stale_position')
    expect(kind('gh: Unprocessable Entity (HTTP 422)\nNo commit found for SHA: abc', post)).toBe(
      'stale_position'
    )
    expect(kind('gh: Validation Failed (HTTP 422)\nbody is too long', post)).toBe('validation')
  })

  it('recognizes server errors and falls back to unknown', () => {
    expect(kind('gh: HTTP 502: Bad Gateway')).toBe('server_error')
    expect(kind('something odd happened')).toBe('unknown')
  })

  it('keeps the original error as redacted detail', () => {
    const p = classifyGhFailure(
      'gh: Bad credentials (HTTP 401)\nAuthorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      read
    )
    expect(p.detail).toContain('Bad credentials (HTTP 401)')
    expect(p.detail).not.toContain('ghp_abc')
  })
})

describe('redactSecrets', () => {
  it('removes every token shape GitHub issues, masked or not', () => {
    const text = [
      'Token: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_************************************',
      'ghs_abcdefghijklmnopqrstuvwxyz0123456789 ghu_abc123abc123abc123abc1 ghr_zzzzzzzzzzzzzzzzzzzz',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'token 0123456789abcdef0123456789abcdef01234567'
    ].join('\n')
    const out = redactSecrets(text)
    expect(out).not.toMatch(/github_pat_|gh[pousr]_|eyJhbGci|0123456789abcdef0123/)
    expect(out).toContain('[redacted]')
  })

  it('leaves commit SHAs and ordinary text alone', () => {
    const sha = '4cb427bf689a01fed190e50dfe2a703793d295d2'
    expect(redactSecrets(`commit ${sha} is not part of the pull request`)).toBe(
      `commit ${sha} is not part of the pull request`
    )
  })
})

describe('describeGhOutput', () => {
  it('adds the API message and errors from the JSON body on stdout', () => {
    const body = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['Pull request review thread line must be part of the diff']
    })
    expect(describeGhOutput('gh: Unprocessable Entity (HTTP 422)', body)).toBe(
      'gh: Unprocessable Entity (HTTP 422)\nPull request review thread line must be part of the diff'
    )
  })

  it('ignores non-JSON stdout', () => {
    expect(describeGhOutput('gh: boom', 'not json')).toBe('gh: boom')
  })
})

describe('conciseDetail', () => {
  it('keeps at most six lines', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    expect(conciseDetail(raw)?.split('\n')).toHaveLength(6)
    expect(conciseDetail('   ')).toBeUndefined()
  })
})

describe('postFailureKind', () => {
  const kindOf = (raw: string, timedOut = false): string =>
    postFailureKind(classifyGhFailure(raw, { operation: 'post', timedOut }), raw)

  it('lets the same preview be sent again when GitHub accepted nothing', () => {
    expect(kindOf('gh: API rate limit exceeded for user ID 1. (HTTP 403)')).toBe('retryable')
    expect(kindOf('dial tcp 140.82.112.6:443: connect: connection refused')).toBe('retryable')
    expect(kindOf('dial tcp: lookup api.github.com: no such host')).toBe('retryable')
  })

  it('asks for a login or permission fix on 401/403/404', () => {
    expect(kindOf('gh: Bad credentials (HTTP 401)')).toBe('needs_auth')
    expect(kindOf('gh: Resource not accessible by personal access token (HTTP 403)')).toBe(
      'needs_auth'
    )
    expect(kindOf('gh: Not Found (HTTP 404)')).toBe('needs_auth')
    expect(kindOf('gh: Resource protected by organization SAML enforcement. (HTTP 403)')).toBe(
      'needs_auth'
    )
  })

  it('asks for a fresh preview when GitHub rejects the content (422)', () => {
    expect(kindOf('gh: Unprocessable Entity (HTTP 422)\nline must be part of the diff')).toBe(
      'needs_new_preview'
    )
    expect(kindOf('Can not request changes on your own pull request')).toBe('needs_new_preview')
    expect(kindOf('gh: Validation Failed (HTTP 422)')).toBe('needs_new_preview')
  })

  it('treats anything that might have reached GitHub as ambiguous', () => {
    expect(kindOf('', true)).toBe('ambiguous')
    expect(kindOf('gh: HTTP 502: Bad Gateway')).toBe('ambiguous')
    expect(kindOf('read tcp: connection reset by peer')).toBe('ambiguous')
    expect(kindOf('unexpected EOF')).toBe('ambiguous')
    expect(kindOf('something nobody has seen before')).toBe('ambiguous')
  })
})
