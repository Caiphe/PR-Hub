import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { MIN_SIZE } from './bounds'
import { registerReviewIpc } from './reviewIpc'
import { loadWindowBounds, trackWindowBounds } from './windowState'

// Lets tests and experiments run against a throwaway data folder (history, window state, reviews).
if (process.env.PR_HUB_USER_DATA) app.setPath('userData', process.env.PR_HUB_USER_DATA)

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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

  trackWindowBounds(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Open external links (e.g. PR URLs) in the default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.prhub.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerReviewIpc()
  createWindow()

  app.on('activate', function () {
    // On macOS, re-create the window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
