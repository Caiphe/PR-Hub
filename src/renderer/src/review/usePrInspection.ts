import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHubProblem, PrMetadata } from '@shared/github'
import { currentPrKey } from './intake'

export type Inspection = { url: string } & (
  | { status: 'loading' }
  | { status: 'ready'; pr: PrMetadata }
  | { status: 'error'; error: string; problem?: GitHubProblem }
)

// Waits for the link to settle so typing or pasting piece by piece doesn't send a request per
// keystroke. The main process caches answers for a couple of minutes.
const SETTLE_MS = 450

/**
 * Inspects the PR the link points at. Returns the inspection only while it matches the current
 * link, so a reply for a link the user has since changed is never shown or used.
 */
export function usePrInspection(
  rawUrl: string,
  /** Called once per finished inspection of the current link: the PR, or null if it failed. */
  onSettled: (url: string, pr: PrMetadata | null) => void
): { inspection: Inspection | null; retry: () => void } {
  const key = currentPrKey(rawUrl)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const latestKey = useRef<string | null>(key)
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
    latestKey.current = key
  })

  const run = useCallback((url: string) => {
    setInspection({ url, status: 'loading' })
    window.api
      .inspectPr(url)
      .then((res) => {
        if (latestKey.current !== url) return
        if (res.ok) {
          setInspection({ url, status: 'ready', pr: res.pr })
          onSettledRef.current(url, res.pr)
        } else {
          setInspection({ url, status: 'error', error: res.error, problem: res.problem })
          onSettledRef.current(url, null)
        }
      })
      .catch((error: Error) => {
        if (latestKey.current !== url) return
        setInspection({ url, status: 'error', error: error.message })
        onSettledRef.current(url, null)
      })
  }, [])

  const known = inspection?.url === key
  useEffect(() => {
    if (!key || known) return
    const timer = setTimeout(() => run(key), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [key, known, run])

  return {
    inspection: known ? inspection : null,
    retry: () => key && run(key)
  }
}
