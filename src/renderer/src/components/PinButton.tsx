import { useEffect, useState } from 'react'

// "Keep on top" toggle. The setting lives in the main process (saved between launches) and can
// also be changed from the menu-bar menu, so this mirrors it rather than owning it.
export function PinButton(): React.JSX.Element {
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.getSettings().then((s) => alive && setPinned(s.alwaysOnTop))
    const unsubscribe = window.api.onSettingsChanged((s) => setPinned(s.alwaysOnTop))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const toggle = async (): Promise<void> => {
    const settings = await window.api.setAlwaysOnTop(!pinned)
    setPinned(settings.alwaysOnTop)
  }

  return (
    <button
      type="button"
      className={`icon-button pin-button ${pinned ? 'is-pinned' : ''}`}
      aria-pressed={pinned}
      aria-label="Keep window on top"
      title={pinned ? 'Kept on top: click to unpin' : 'Keep window on top'}
      onClick={toggle}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2z M8 9.5v4"
          fill={pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
