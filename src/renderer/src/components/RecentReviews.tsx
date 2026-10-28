import { useEffect, useState } from 'react'
import type { HistorySummary } from '@shared/history'
import { formatRelative, prLabel } from '../review/format'
import { VERDICTS } from '../review/verdict'

const SHOWN = 3

function Badge({ item }: { item: HistorySummary }): React.JSX.Element {
  if (item.status === 'error') return <span className="pill pill-bad">Failed</span>
  if (!item.verdict) return <span className="pill pill-muted">Done</span>
  const verdict = VERDICTS[item.verdict]
  return <span className={`pill pill-${verdict.tone}`}>{verdict.label}</span>
}

export function RecentReviews({
  onOpen
}: {
  onOpen: (id: string) => void
}): React.JSX.Element | null {
  const [items, setItems] = useState<HistorySummary[] | null>(null)
  // "Time ago" is measured from when the list loaded; the form view remounts often enough.
  const [now, setNow] = useState(0)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (list: HistorySummary[]): void => {
      if (!alive) return
      setNow(Date.now())
      setItems(list)
    }
    window.api
      .listHistory()
      .then(load)
      .catch(() => load([]))
    return () => {
      alive = false
    }
  }, [])

  if (!items || items.length === 0) return null
  const visible = showAll ? items : items.slice(0, SHOWN)

  return (
    <section className="recent" aria-label="Recent reviews">
      <h2 className="section-title">Recent reviews</h2>
      <ul className={showAll ? 'recent-list is-expanded' : 'recent-list'}>
        {visible.map((item) => (
          <li key={item.id}>
            <button type="button" className="recent-item" onClick={() => onOpen(item.id)}>
              <span className="recent-main">
                <span className="recent-title">{item.title}</span>
                <span className="recent-meta">
                  {prLabel(item.prUrl)} · {formatRelative(item.startedAt, now)}
                </span>
              </span>
              <Badge item={item} />
            </button>
          </li>
        ))}
      </ul>
      {items.length > SHOWN && (
        <button type="button" className="link-button small" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  )
}
