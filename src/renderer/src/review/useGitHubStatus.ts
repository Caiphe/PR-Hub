import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { StatusView } from './githubStatus'

export interface GitHubStatusState {
  view: StatusView
  open: boolean
  toggle: () => void
  /** Checks the login; with a PR link, also whether that PR can be read. */
  check: (prUrl?: string) => void
  panelId: string
}

// The login is checked once when the form opens. The repository is only checked when the
// user asks, so typing a link never sends requests to GitHub.
export function useGitHubStatus(): GitHubStatusState {
  const [view, setView] = useState<StatusView>({ kind: 'checking' })
  const [open, setOpen] = useState(false)
  // Answers to superseded checks are dropped, so a slow reply can't overwrite a newer one.
  const latest = useRef(0)
  const panelId = useId()

  // Sets state only when the answer arrives, so it's safe to call from an effect.
  const run = useCallback((prUrl?: string) => {
    const request = ++latest.current
    window.api
      .githubStatus(prUrl)
      .then((status) => request === latest.current && setView({ kind: 'ready', status }))
      .catch(
        (error: Error) =>
          request === latest.current && setView({ kind: 'failed', message: error.message })
      )
  }, [])

  const check = useCallback(
    (prUrl?: string) => {
      setView({ kind: 'checking' })
      run(prUrl)
    },
    [run]
  )

  useEffect(() => {
    const counter = latest
    run()
    return () => {
      counter.current++
    }
  }, [run])

  return { view, open, toggle: () => setOpen((o) => !o), check, panelId }
}
