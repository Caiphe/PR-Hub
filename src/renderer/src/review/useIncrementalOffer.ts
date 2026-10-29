import { useEffect, useState } from 'react'
import type { IncrementalOffer } from '@shared/ipc'
import { parsePrUrl } from '@shared/validate'

export type OfferState = { key: string } & (
  { status: 'loading' } | { status: 'ready'; offer: IncrementalOffer }
)

const SETTLE_MS = 450

/**
 * Whether the PR has a previous review that an incremental re-review could compare against.
 * Only the answer for the current link (and parent) is returned, so a late reply for a link
 * the user has since changed is never shown.
 */
export function useIncrementalOffer(rawUrl: string, parentId?: string): OfferState | null {
  const url = parsePrUrl(rawUrl)?.url ?? null
  const key = url ? `${url.toLowerCase()} ${parentId ?? ''}` : null
  const [state, setState] = useState<OfferState | null>(null)

  useEffect(() => {
    if (!url || !key) return
    let alive = true
    const timer = setTimeout(() => {
      setState({ key, status: 'loading' })
      window.api
        .incrementalOffer(url, parentId)
        .then((offer) => alive && setState({ key, status: 'ready', offer }))
        .catch(() => {
          if (alive) {
            setState({
              key,
              status: 'ready',
              offer: { parent: null, headSha: null, available: false, reason: null, message: null }
            })
          }
        })
    }, SETTLE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [url, key, parentId])

  return state && state.key === key ? state : null
}

export type ReviewMode = 'incremental' | 'full'

/** The incremental choice is used only when it's offered; otherwise every review is full. */
export function chosenParent(offer: OfferState | null, mode: ReviewMode): string | null {
  if (mode !== 'incremental' || offer?.status !== 'ready') return null
  return offer.offer.available ? (offer.offer.parent?.id ?? null) : null
}
