import { describe, expect, it } from 'vitest'
import { failureView, shortSha, type PostFailure } from './postFlow'

const failed = (over: Partial<PostFailure>): PostFailure => ({
  ok: false,
  error: 'e',
  failure: 'retryable',
  ...over
})

describe('failureView', () => {
  it('offers to resend the same preview only when nothing reached GitHub', () => {
    expect(failureView(failed({ failure: 'retryable' }))).toMatchObject({
      primary: 'retry',
      locked: false
    })
    expect(failureView(failed({ failure: 'needs_auth' }))).toMatchObject({
      primary: 'retry',
      secondary: ['rebuild'],
      locked: false
    })
  })

  it('asks for a new preview after GitHub rejects the content', () => {
    expect(failureView(failed({ failure: 'needs_new_preview' })).primary).toBe('rebuild')
    expect(
      failureView(
        failed({
          failure: 'needs_new_preview',
          problem: { kind: 'own_pr_request_changes', title: 't', message: 'm', actions: [] }
        })
      ).primary
    ).toBe('switch_to_comment')
  })

  it('never makes resending the default after an unclear outcome, and locks the review', () => {
    for (const checked of ['not_found', 'lookup_failed'] as const) {
      const view = failureView(failed({ failure: 'ambiguous', checked }))
      expect(view.primary).toBe('check')
      expect(view.primary).not.toMatch(/post|retry/)
      expect(view.locked).toBe(true)
    }
    expect(failureView(failed({ failure: 'ambiguous', checked: 'not_found' })).secondary).toEqual([
      'post_again'
    ])
    expect(
      failureView(failed({ failure: 'ambiguous', checked: 'lookup_failed' })).secondary
    ).toEqual(['post_anyway'])
  })
})

describe('shortSha', () => {
  it('shortens commits', () => {
    expect(shortSha('4cb427bf689a01fed190e50dfe2a703793d295d2')).toBe('4cb427b')
    expect(shortSha(null)).toBe('unknown')
  })
})
