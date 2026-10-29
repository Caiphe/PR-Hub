import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ReviewEventBody } from '../shared/ipc'
import { notificationBody, notifyFinished, type NotifyDeps } from './notifications'

const input = { title: 'Fix login', prUrl: 'https://github.com/a/b/pull/1', description: '' }
const done: ReviewEventBody = {
  type: 'done',
  result: {
    markdown: '',
    findings: {
      verdict: 'request_changes',
      summary: '',
      requirements: [],
      findings: [{ id: 'f1', severity: 'blocking', title: 'x', body: '' }]
    },
    costUsd: null,
    durationMs: 1,
    deniedTools: []
  }
}
const deps = (over: Partial<Omit<NotifyDeps, 'show'>> = {}): NotifyDeps & { show: Mock } => ({
  enabled: true,
  windowHidden: true,
  supported: true,
  show: vi.fn(),
  ...over
})

describe('notifyFinished', () => {
  it('shows a notification when enabled and the window is hidden', () => {
    const d = deps()
    expect(notifyFinished(input, done, d)).toBe(true)
    expect(d.show).toHaveBeenCalledWith({
      title: 'Fix login',
      body: 'Request changes · 1 blocking'
    })
  })

  it('never shows one when notifications are turned off', () => {
    const d = deps({ enabled: false })
    expect(notifyFinished(input, done, d)).toBe(false)
    expect(notifyFinished(input, { type: 'error', message: 'x' }, d)).toBe(false)
    expect(d.show).not.toHaveBeenCalled()
  })

  it('stays quiet when the window is visible, unsupported, or the review was cancelled', () => {
    for (const d of [deps({ windowHidden: false }), deps({ supported: false })]) {
      expect(notifyFinished(input, done, d)).toBe(false)
      expect(d.show).not.toHaveBeenCalled()
    }
    expect(notificationBody({ type: 'cancelled' })).toBeNull()
    expect(notificationBody({ type: 'error', message: 'x' })).toBe(
      'Review failed. Open PR Hub for details.'
    )
  })
})
