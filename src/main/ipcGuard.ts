import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { pathToFileURL } from 'url'

// The preload exposes window.api to whatever page the window shows. Navigation away from the
// app is blocked (see index.ts), and as a second layer every handler checks that the call
// comes from the app's own renderer page before doing anything.
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) return url.startsWith(`${new URL(devUrl).origin}/`)
  return url.startsWith(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
}

export function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error(`Rejected ${channel} from an untrusted page`)
    return listener(event, ...args)
  })
}
