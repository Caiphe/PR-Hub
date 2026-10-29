import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'

/** Settings as saved in main, kept current when they change elsewhere (tray, Settings view). */
export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    let alive = true
    window.api
      .getSettings()
      .then((s) => alive && setSettings(s))
      .catch(() => {})
    const unsubscribe = window.api.onSettingsChanged((s) => setSettings(s))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  return settings
}
