import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings } from '../shared/ipc'

const DEFAULTS: Settings = { alwaysOnTop: false }

const file = (): string => join(app.getPath('userData'), 'settings.json')

let current: Settings | null = null

export function getSettings(): Settings {
  if (current) return current
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>
    current = { alwaysOnTop: saved.alwaysOnTop === true }
  } catch {
    current = { ...DEFAULTS } // First launch or unreadable file.
  }
  return current
}

export function updateSettings(change: Partial<Settings>): Settings {
  current = { ...getSettings(), ...change }
  try {
    writeFileSync(`${file()}.tmp`, JSON.stringify(current))
    renameSync(`${file()}.tmp`, file())
  } catch (error) {
    console.error('Failed to save settings', error)
  }
  return current
}
