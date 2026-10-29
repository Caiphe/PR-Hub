import { app, shell, BrowserWindow, Notification, type Tray } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC, type ReviewEventBody, type Settings } from '../shared/ipc'
import type { ReviewInput } from '../shared/validate'
import { MIN_SIZE } from './bounds'
import { openExternalInFirefox } from './externalBrowser'
import { registerGithubIpc } from './githubIpc'
import { handle } from './ipcGuard'
import { cancelAllReviews, hasRunningReviews, registerReviewIpc } from './reviewIpc'
import { getSettings, updateSettings } from './settings'
import { createTray } from './tray'
import { loadWindowBounds, trackWindowBounds } from './windowState'

// Lets tests and experiments run against a throwaway data folder (history, window state, reviews).
if (process.env.PR_HUB_USER_DATA) app.setPath('userData', process.env.PR_HUB_USER_DATA)

// One instance per data folder: two would race on history.json, and each would sweep the
// other's running review folders as orphans. A second launch just shows the existing window.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

let mainWindow: BrowserWindow | null = null
// Kept referenced: a garbage-collected Tray disappears from the menu bar.
let tray: Tray | null = null
let quitting = false

function openExternalUrl(url: string): void {
  void openExternalInFirefox(url, (target) => shell.openExternal(target)).catch((error) =>
    console.error('Failed to open external link', error)
  )
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...loadWindowBounds(),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    resizable: true,
    fullscreenable: false,
    title: 'PR Hub',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  trackWindowBounds(win)
  applyPinned(win, getSettings().alwaysOnTop)

  win.on('ready-to-show', () => win.show())

  // Closing hides the window so reviews keep running and the menu-bar icon brings it back.
  // Quitting (Cmd+Q, tray menu) really closes it.
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Open external links (e.g. PR URLs) in local Firefox, never in-app.
  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) openExternalUrl(details.url)
    return { action: 'deny' }
  })
  // The window only ever shows the app. Navigating it (a clicked link without target=_blank,
  // a file dropped on the window) would hand window.api to another page.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) openExternalUrl(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function showWindow(): BrowserWindow {
  mainWindow ??= createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide()
  else showWindow()
}

function applyPinned(win: BrowserWindow, pinned: boolean): void {
  // 'floating' keeps it above normal windows without covering menus and alerts.
  win.setAlwaysOnTop(pinned, 'floating')
}

function setPinned(pinned: boolean): Settings {
  const settings = updateSettings({ alwaysOnTop: pinned })
  if (mainWindow) {
    applyPinned(mainWindow, pinned)
    mainWindow.webContents.send(IPC.settingsChanged, settings)
  }
  return settings
}

function isWindowHidden(): boolean {
  return !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()
}

// Reviews take minutes; if the window was put away meanwhile, say when one is done.
function notifyFinished(input: ReviewInput, event: ReviewEventBody): void {
  if (!isWindowHidden() || !Notification.isSupported()) return
  let body: string
  if (event.type === 'done') {
    const findings = event.result.findings
    const blocking = findings?.findings.filter((f) => f.severity === 'blocking').length ?? 0
    const verdict = findings?.verdict.replaceAll('_', ' ') ?? 'review ready'
    body = `${verdict[0].toUpperCase()}${verdict.slice(1)}${blocking ? ` · ${blocking} blocking` : ''}`
  } else if (event.type === 'error') {
    body = 'Review failed. Open PR Hub for details.'
  } else {
    return
  }
  const notification = new Notification({ title: input.title, body, silent: false })
  notification.on('click', () => showWindow())
  notification.show()
}

function newReview(): void {
  showWindow().webContents.send(IPC.newReview)
}

app.on('second-instance', () => showWindow())

app.whenReady().then(() => {
  if (!isPrimaryInstance) return
  electronApp.setAppUserModelId('com.prhub.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerReviewIpc({ onFinished: notifyFinished })
  registerGithubIpc()
  handle(IPC.getSettings, () => getSettings())
  handle(IPC.setAlwaysOnTop, (_event, pinned) => setPinned(pinned === true))

  mainWindow = createWindow()
  tray = createTray({
    isVisible: () => !isWindowHidden(),
    toggleWindow,
    isPinned: () => getSettings().alwaysOnTop,
    setPinned,
    newReview
  })

  // Dock icon click on macOS: bring the (possibly hidden) window back.
  app.on('activate', () => showWindow())
})

let reviewsStopped = false
app.on('before-quit', (event) => {
  quitting = true
  // Don't leave headless sessions running (and billing) after quit: stop them first,
  // bounded so a stuck process can't block quitting.
  if (!reviewsStopped && hasRunningReviews()) {
    event.preventDefault()
    reviewsStopped = true
    void cancelAllReviews(4000).then(() => app.quit())
  }
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
