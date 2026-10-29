import { execFile as nodeExecFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Browser } from '../shared/settings'

// Opens web links in the browser chosen in Settings, without changing the macOS default
// browser. macOS only: `open -b <bundle id> <url>` with an argument array and no shell, so the
// URL can never become a command. Anything else, or a failed launch, uses the system browser.

type NamedBrowser = Exclude<Browser, 'system'>

const BROWSER_APPS: Record<NamedBrowser, { bundleId: string; app: string }> = {
  firefox: { bundleId: 'org.mozilla.firefox', app: 'Firefox.app' },
  chrome: { bundleId: 'com.google.Chrome', app: 'Google Chrome.app' }
}

export type ExecFile = (
  file: string,
  args: string[],
  callback: (error: Error | null) => void
) => unknown

type SystemBrowser = (url: string) => Promise<void>

export interface OpenOutcome {
  opened: Browser
  /** Set when the chosen browser couldn't be launched and the system browser was used. */
  fallbackFrom?: NamedBrowser
}

/** Only plain http(s) links, with no credentials and nothing a parser could read two ways. */
export function isWebUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length > 8192) return false
  // Whitespace or control characters: browsers and URL parsers disagree on those.
  if ([...url].some((c) => c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f)) return false
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username &&
      !parsed.password &&
      parsed.hostname !== ''
    )
  } catch {
    return false
  }
}

export function openExternal(
  url: string,
  browser: Browser,
  systemBrowser: SystemBrowser,
  platform: NodeJS.Platform = process.platform,
  execFile: ExecFile = nodeExecFile as ExecFile
): Promise<OpenOutcome> {
  if (!isWebUrl(url)) return Promise.reject(new Error('Refused to open a link that is not http(s)'))
  if (browser === 'system' || platform !== 'darwin') {
    return systemBrowser(url).then(() => ({ opened: 'system' }))
  }

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-b', BROWSER_APPS[browser].bundleId, url], (error) => {
      if (!error) {
        resolve({ opened: browser })
        return
      }
      // Keep links usable if the browser was removed or its bundle id can't be resolved.
      systemBrowser(url).then(() => resolve({ opened: 'system', fallbackFrom: browser }), reject)
    })
  })
}

/**
 * Whether each browser looks installed, for the Settings view. A best-effort look in the
 * Applications folders: a browser installed elsewhere may still open, and a missing one falls
 * back to the system browser either way.
 */
export function installedBrowsers(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir()
): Record<Browser, boolean> {
  const has = (b: NamedBrowser): boolean =>
    platform === 'darwin' &&
    [
      join('/Applications', BROWSER_APPS[b].app),
      join(home, 'Applications', BROWSER_APPS[b].app)
    ].some(exists)
  return { system: true, firefox: has('firefox'), chrome: has('chrome') }
}
