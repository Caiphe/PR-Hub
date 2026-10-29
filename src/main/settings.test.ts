import { mkdtemp, readdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
const { SettingsStore } = await import('./settings')

let dir: string
const saved = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-hub-settings-'))
})

describe('SettingsStore migration', () => {
  it('migrates a version 1 file to Firefox, keeps keep-on-top, and saves once', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ alwaysOnTop: true }))
    const settings = new SettingsStore(dir).get()
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, alwaysOnTop: true, browser: 'firefox' })
    expect(await saved()).toEqual({ version: 2, ...settings })
  })

  it('treats existing history or window state as an upgrade', async () => {
    await writeFile(join(dir, 'window-state.json'), '{}')
    expect(new SettingsStore(dir).get().browser).toBe('firefox')
  })

  it('gives a new install the system browser', async () => {
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS)
    expect((await saved()).browser).toBe('system')
  })

  it('does not migrate again once saved: a later System default choice sticks', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ alwaysOnTop: false }))
    new SettingsStore(dir).update({ browser: 'system' })
    expect(new SettingsStore(dir).get().browser).toBe('system')
  })

  it('starts from safe defaults when the file is unreadable', async () => {
    await writeFile(join(dir, 'settings.json'), '{not json')
    const settings = new SettingsStore(dir).get()
    expect(settings.reviewTimeoutMinutes).toBe(15)
    expect((await saved()).version).toBe(2)
  })
})

describe('SettingsStore persistence', () => {
  it('validates, saves atomically and reloads', async () => {
    const store = new SettingsStore(dir)
    const next = store.update({ reviewTimeoutMinutes: 25, model: 'haiku', browser: 'edge' })
    expect(next).toMatchObject({ reviewTimeoutMinutes: 25, model: 'haiku', browser: 'system' })
    expect(new SettingsStore(dir).get()).toEqual(next)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('restores defaults', () => {
    const store = new SettingsStore(dir)
    store.update({ browser: 'chrome', notifications: false, historyLimit: 200 })
    expect(store.restoreDefaults()).toEqual(DEFAULT_SETTINGS)
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps a change for this run when it cannot be saved', () => {
    const store = new SettingsStore(join(dir, 'missing-folder'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(store.update({ notifications: false }).notifications).toBe(false)
    expect(store.get().notifications).toBe(false)
  })
})
