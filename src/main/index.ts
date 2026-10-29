import { app, shell, BrowserWindow, Notification, type Tray } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC, type BrowserStatus, type ReviewEventBody, type Settings } from '../shared/ipc'
import type { ReviewInput } from '../shared/validate'
import { MIN_SIZE } from './bounds'
import { installedBrowsers, openExternal } from './externalBrowser'
import { registerGithubIpc } from './githubIpc'
import { registerHistoryIpc } from './historyIpc'
import { handle } from './ipcGuard'
import { notifyFinished as notify } from './notifications'
import { cancelAllReviews, hasRunningReviews, registerReviewIpc } from './reviewIpc'
import { getSettings, restoreDefaultSettings, updateSettings } from './settings'
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
// The chosen browser that last failed to launch, shown in Settings to explain the fallback.
let lastBrowserFallback: BrowserStatus['lastFallback'] = null

function openExternalUrl(url: string): void {
  void openExternal(url, getSettings().browser, (target) => shell.openExternal(target))
    .then((outcome) => {
      if (outcome.fallbackFrom) {
        lastBrowserFallback = outcome.fallbackFrom
        console.error(`Couldn't open ${outcome.fallbackFrom}; used the system browser instead`)
      } else if (outcome.opened !== 'system') {
        lastBrowserFallback = null
      }
    })
    .catch((error) => console.error('Failed to open external link', error))
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

  // Open external links (e.g. PR URLs) in the browser chosen in Settings, never in-app.
  // openExternal validates the URL again before launching anything.
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

// Every settings change goes through here, so the window and the renderer always agree with
// what's saved. Settings that only matter for the next review need nothing applied now.
function changeSettings(next: Settings): Settings {
  if (mainWindow) {
    applyPinned(mainWindow, next.alwaysOnTop)
    mainWindow.webContents.send(IPC.settingsChanged, next)
  }
  return next
}

function setPinned(pinned: boolean): Settings {
  return changeSettings(updateSettings({ alwaysOnTop: pinned }))
}

function isWindowHidden(): boolean {
  return !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()
}

function notifyFinished(input: ReviewInput, event: ReviewEventBody): void {
  notify(input, event, {
    enabled: getSettings().notifications,
    windowHidden: isWindowHidden(),
    supported: Notification.isSupported(),
    show: ({ title, body }) => {
      const notification = new Notification({ title, body, silent: false })
      notification.on('click', () => showWindow())
      notification.show()
    }
  })
}

function newReview(): void {
  showWindow().webContents.send(IPC.newReview)
}

function openSettings(): void {
  showWindow().webContents.send(IPC.openSettings)
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
  registerHistoryIpc()
  handle(IPC.getSettings, () => getSettings())
  handle(IPC.setAlwaysOnTop, (_event, pinned) => setPinned(pinned === true))
  handle(IPC.updateSettings, (_event, change) => changeSettings(updateSettings(change)))
  handle(IPC.restoreSettings, () => changeSettings(restoreDefaultSettings()))
  handle(IPC.browserStatus, (): BrowserStatus => ({
    installed: installedBrowsers(),
    lastFallback: lastBrowserFallback
  }))

  mainWindow = createWindow()
  tray = createTray({
    isVisible: () => !isWindowHidden(),
    toggleWindow,
    isPinned: () => getSettings().alwaysOnTop,
    setPinned,
    notificationsOn: () => getSettings().notifications,
    setNotifications: (on) => changeSettings(updateSettings({ notifications: on })),
    newReview,
    openSettings
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
