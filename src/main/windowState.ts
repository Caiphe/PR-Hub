import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { resolveBounds, type Rect, type SavedBounds } from './bounds'

const stateFile = (): string => join(app.getPath('userData'), 'window-state.json')

export function loadWindowBounds(): ReturnType<typeof resolveBounds> {
  let saved: SavedBounds | null = null
  try {
    saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    // First launch or unreadable file: fall back to defaults.
  }
  return resolveBounds(
    saved,
    screen.getAllDisplays().map((d) => d.workArea)
  )
}

function saveWindowBounds(bounds: Rect): void {
  const file = stateFile()
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(bounds))
    renameSync(`${file}.tmp`, file)
  } catch (error) {
    console.error('Failed to save window bounds', error)
  }
}

export function trackWindowBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => saveWindowBounds(win.getNormalBounds()), 300)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', () => {
    clearTimeout(timer)
    saveWindowBounds(win.getNormalBounds())
  })
}
