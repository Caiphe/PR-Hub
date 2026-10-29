import { describe, expect, it } from 'vitest'
import {
  applySettingsChange,
  DEFAULT_SETTINGS,
  diffSettings,
  normalizeSettings,
  reviewRunSettings,
  type Settings
} from './settings'

describe('normalizeSettings', () => {
  it('keeps Firefox for an install upgraded from the hardcoded-Firefox version', () => {
    expect(normalizeSettings({ alwaysOnTop: true }, true)).toEqual({
      ...DEFAULT_SETTINGS,
      alwaysOnTop: true,
      browser: 'firefox'
    })
    // Older builds only wrote settings.json after a pin change; other data shows the upgrade.
    expect(normalizeSettings(null, true).browser).toBe('firefox')
  })

  it('starts a new install with the system browser', () => {
    expect(normalizeSettings(null, false)).toEqual(DEFAULT_SETTINGS)
  })

  it('reads a current file as saved, including an explicit System default', () => {
    const saved: Settings = {
      alwaysOnTop: true,
      browser: 'system',
      defaultPostMode: 'request_changes',
      reviewTimeoutMinutes: 30,
      model: 'opus[1m]',
      historyLimit: 120,
      notifications: false
    }
    expect(normalizeSettings({ version: 2, ...saved }, true)).toEqual(saved)
  })

  it('replaces invalid or obsolete values with safe defaults', () => {
    expect(
      normalizeSettings(
        {
          version: 2,
          alwaysOnTop: 'yes',
          browser: 'safari',
          defaultPostMode: 'approve',
          reviewTimeoutMinutes: 'ten',
          model: '--dangerously-skip-permissions',
          historyLimit: Number.NaN,
          notifications: 0,
          shellCommand: 'rm -rf ~'
        },
        true
      )
    ).toEqual({ ...DEFAULT_SETTINGS, notifications: true })
    expect(normalizeSettings('garbage', false)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([1, 2], false)).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps numbers into their safe ranges', () => {
    const s = normalizeSettings({ version: 2, reviewTimeoutMinutes: 1, historyLimit: 1e9 }, true)
    expect(s.reviewTimeoutMinutes).toBe(5)
    expect(s.historyLimit).toBe(500)
    expect(
      normalizeSettings({ version: 2, reviewTimeoutMinutes: 20.6 }, true).reviewTimeoutMinutes
    ).toBe(21)
  })
})

describe('applySettingsChange', () => {
  it('applies valid changes and ignores bad values and unknown keys', () => {
    const next = applySettingsChange(DEFAULT_SETTINGS, {
      browser: 'chrome',
      defaultPostMode: 'nope',
      reviewTimeoutMinutes: 90,
      model: 'bad model; rm',
      notifications: 'off',
      claudePath: '/tmp/evil'
    })
    expect(next).toEqual({ ...DEFAULT_SETTINGS, browser: 'chrome', reviewTimeoutMinutes: 60 })
    expect(next).not.toHaveProperty('claudePath')
    expect(applySettingsChange(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS)
  })

  it('trims a model and lets blank clear it', () => {
    const withModel = applySettingsChange(DEFAULT_SETTINGS, { model: '  sonnet ' })
    expect(withModel.model).toBe('sonnet')
    expect(applySettingsChange(withModel, { model: '' }).model).toBe('')
  })
})

describe('diffSettings', () => {
  it('lists what restoring defaults changes', () => {
    const current = { ...DEFAULT_SETTINGS, browser: 'firefox' as const, model: 'haiku' }
    expect(diffSettings(current)).toEqual([
      { key: 'browser', label: 'Open links in', from: 'Firefox', to: 'System default' },
      { key: 'model', label: 'Model', from: 'haiku', to: 'Claude Code default' }
    ])
    expect(diffSettings(DEFAULT_SETTINGS)).toEqual([])
  })
})

describe('reviewRunSettings precedence', () => {
  it('uses the Settings model over PR_HUB_MODEL', () => {
    expect(reviewRunSettings({ ...DEFAULT_SETTINGS, model: 'opus' }, 'haiku').model).toBe('opus')
  })

  it('falls back to PR_HUB_MODEL, then to the Claude Code default', () => {
    expect(reviewRunSettings(DEFAULT_SETTINGS, 'haiku').model).toBe('haiku')
    expect(reviewRunSettings(DEFAULT_SETTINGS, undefined).model).toBeUndefined()
    expect(reviewRunSettings(DEFAULT_SETTINGS, '').model).toBeUndefined()
    // A malformed variable is ignored rather than passed to claude.
    expect(reviewRunSettings(DEFAULT_SETTINGS, '--print x').model).toBeUndefined()
  })

  it('turns the timeout setting into milliseconds', () => {
    expect(reviewRunSettings(DEFAULT_SETTINGS, undefined).timeoutMs).toBe(15 * 60 * 1000)
    expect(
      reviewRunSettings({ ...DEFAULT_SETTINGS, reviewTimeoutMinutes: 40 }, undefined).timeoutMs
    ).toBe(40 * 60 * 1000)
  })
})
