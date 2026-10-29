import type { ReviewEventBody } from '../shared/ipc'
import type { ReviewInput } from '../shared/validate'

export interface NotifyDeps {
  enabled: boolean
  windowHidden: boolean
  supported: boolean
  show: (options: { title: string; body: string }) => void
}

/** The notification text for a finished review, or null when there's nothing to say. */
export function notificationBody(event: ReviewEventBody): string | null {
  if (event.type === 'done') {
    const findings = event.result.findings
    const blocking = findings?.findings.filter((f) => f.severity === 'blocking').length ?? 0
    const verdict = findings?.verdict.replaceAll('_', ' ') ?? 'review ready'
    return `${verdict[0].toUpperCase()}${verdict.slice(1)}${blocking ? ` · ${blocking} blocking` : ''}`
  }
  if (event.type === 'error') return 'Review failed. Open PR Hub for details.'
  return null
}

// Reviews take minutes; if the window was put away meanwhile, say when one is done. Off when
// completion notifications are turned off in Settings.
export function notifyFinished(
  input: ReviewInput,
  event: ReviewEventBody,
  deps: NotifyDeps
): boolean {
  if (!deps.enabled || !deps.windowHidden || !deps.supported) return false
  const body = notificationBody(event)
  if (!body) return false
  deps.show({ title: input.title, body })
  return true
}
