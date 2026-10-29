import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  applySettingsChange,
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTINGS_VERSION,
  type Settings
} from '../shared/settings'

// settings.json in the data folder. Reads are tolerant (any version, any garbage becomes safe
// defaults); writes go to a temp file renamed into place, so a crash never leaves half a file.
export class SettingsStore {
  private current: Settings | null = null

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'settings.json')
  }

  get(): Settings {
    if (this.current) return this.current
    // Any of these means PR Hub ran here before settings had a version (see normalizeSettings).
    const existingInstall = ['settings.json', 'history.json', 'window-state.json'].some((f) =>
      existsSync(join(this.dir, f))
    )
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // First launch or unreadable file: defaults (with the migration rule above).
    }
    this.current = normalizeSettings(raw, existingInstall)
    // Save the migrated form once, so the upgrade decision is made only on the first launch.
    if ((raw as { version?: unknown } | null)?.version !== SETTINGS_VERSION) this.save(this.current)
    return this.current
  }

  /** Validates and saves a change; returns the settings now in effect. */
  update(change: unknown): Settings {
    return this.save(applySettingsChange(this.get(), change))
  }

  restoreDefaults(): Settings {
    return this.save({ ...DEFAULT_SETTINGS })
  }

  private save(next: Settings): Settings {
    this.current = next
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: SETTINGS_VERSION, ...next }))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (error) {
      // Still applied for this run; the next change tries to save again.
      console.error('Failed to save settings', error)
    }
    return next
  }
}

let store: SettingsStore | null = null
const settingsStore = (): SettingsStore => (store ??= new SettingsStore(app.getPath('userData')))

export function getSettings(): Settings {
  return settingsStore().get()
}

export function updateSettings(change: unknown): Settings {
  return settingsStore().update(change)
}

export function restoreDefaultSettings(): Settings {
  return settingsStore().restoreDefaults()
}
