import { execFile as nodeExecFile } from 'child_process'

const FIREFOX_BUNDLE_ID = 'org.mozilla.firefox'

export type ExecFile = (
  file: string,
  args: string[],
  callback: (error: Error | null) => void
) => unknown

type SystemBrowser = (url: string) => Promise<void>

/** Opens app links in local Firefox without changing the macOS default browser. */
export function openExternalInFirefox(
  url: string,
  systemBrowser: SystemBrowser,
  platform: NodeJS.Platform = process.platform,
  execFile: ExecFile = nodeExecFile as ExecFile
): Promise<void> {
  if (platform !== 'darwin') return systemBrowser(url)

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-b', FIREFOX_BUNDLE_ID, url], (error) => {
      if (!error) {
        resolve()
        return
      }
      // Keep links usable if Firefox is removed or its bundle ID can't be resolved.
      systemBrowser(url).then(resolve, reject)
    })
  })
}
