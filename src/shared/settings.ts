// App settings: types, safe ranges, migration and normalization. Pure and shared, so main
// (which owns and validates the file) and the Settings view use the same rules.

export const BROWSERS = ['system', 'firefox', 'chrome'] as const
export type Browser = (typeof BROWSERS)[number]

export const POST_MODES = ['comment', 'request_changes'] as const
export type DefaultPostMode = (typeof POST_MODES)[number]

export const TIMEOUT_MINUTES = { min: 5, max: 60, default: 15 } as const
export const HISTORY_RETENTION = { min: 10, max: 500, default: 50 } as const

/**
 * Model names as Claude Code accepts them: aliases ("sonnet", "opus[1m]") and ids
 * ("claude-sonnet-5-5"). Passed as one argument with no shell, but still kept to a plain shape.
 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/

/** 1: only `alwaysOnTop`, no version field (and links always opened in Firefox). 2: this. */
export const SETTINGS_VERSION = 2

export interface Settings {
  /** Keep the window above other windows ("pin on top"). */
  alwaysOnTop: boolean
  /** Where external links open. Never changes the macOS default browser. */
  browser: Browser
  /** Review type preselected in the post dialog. */
  defaultPostMode: DefaultPostMode
  reviewTimeoutMinutes: number
  /** Blank: PR_HUB_MODEL if set, else Claude Code's default. */
  model: string
  /** Unpinned reviews kept in history. */
  historyLimit: number
  /** Notify when a review finishes while the window is hidden. */
  notifications: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  alwaysOnTop: false,
  browser: 'system',
  defaultPostMode: 'comment',
  reviewTimeoutMinutes: TIMEOUT_MINUTES.default,
  model: '',
  historyLimit: HISTORY_RETENTION.default,
  notifications: true
}

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.find((v) => v === value) ?? fallback

/** Whole numbers in range; out-of-range values are clamped, anything else is the default. */
function inRange(value: unknown, range: { min: number; max: number; default: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.default
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

export function normalizeModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : ''
  return MODEL_PATTERN.test(model) ? model : ''
}

/**
 * Reads a saved settings file (any version) into valid settings. Invalid or obsolete values
 * fall back to safe defaults. `existingInstall`: PR Hub has run here before. Version 1 builds
 * always opened links in Firefox, so an upgraded install keeps Firefox; a new one starts with
 * the system default.
 */
export function normalizeSettings(raw: unknown, existingInstall: boolean): Settings {
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const legacy = saved.version === undefined
  const browserDefault: Browser = legacy && existingInstall ? 'firefox' : DEFAULT_SETTINGS.browser
  return {
    alwaysOnTop: saved.alwaysOnTop === true,
    browser: oneOf(BROWSERS, saved.browser, browserDefault),
    defaultPostMode: oneOf(POST_MODES, saved.defaultPostMode, DEFAULT_SETTINGS.defaultPostMode),
    reviewTimeoutMinutes: inRange(saved.reviewTimeoutMinutes, TIMEOUT_MINUTES),
    model: normalizeModel(saved.model),
    historyLimit: inRange(saved.historyLimit, HISTORY_RETENTION),
    notifications: saved.notifications !== false
  }
}

/** Applies a change from the renderer: unknown keys are ignored, bad values keep the current. */
export function applySettingsChange(current: Settings, change: unknown): Settings {
  const c = (change && typeof change === 'object' ? change : {}) as Record<string, unknown>
  const next = { ...current }
  if (typeof c.alwaysOnTop === 'boolean') next.alwaysOnTop = c.alwaysOnTop
  if (typeof c.notifications === 'boolean') next.notifications = c.notifications
  next.browser = oneOf(BROWSERS, c.browser, current.browser)
  next.defaultPostMode = oneOf(POST_MODES, c.defaultPostMode, current.defaultPostMode)
  if (typeof c.reviewTimeoutMinutes === 'number') {
    next.reviewTimeoutMinutes = inRange(c.reviewTimeoutMinutes, {
      ...TIMEOUT_MINUTES,
      default: current.reviewTimeoutMinutes
    })
  }
  if (typeof c.historyLimit === 'number') {
    next.historyLimit = inRange(c.historyLimit, {
      ...HISTORY_RETENTION,
      default: current.historyLimit
    })
  }
  if (typeof c.model === 'string') {
    const model = c.model.trim()
    if (model === '' || MODEL_PATTERN.test(model)) next.model = model
  }
  return next
}

export const BROWSER_LABELS: Record<Browser, string> = {
  system: 'System default',
  firefox: 'Firefox',
  chrome: 'Chrome'
}

const LABELS: Record<keyof Settings, string> = {
  alwaysOnTop: 'Keep on top',
  browser: 'Open links in',
  defaultPostMode: 'Default review type',
  reviewTimeoutMinutes: 'Review timeout',
  model: 'Model',
  historyLimit: 'Reviews kept',
  notifications: 'Completion notifications'
}

export function settingText<K extends keyof Settings>(key: K, value: Settings[K]): string {
  switch (key) {
    case 'alwaysOnTop':
    case 'notifications':
      return value ? 'On' : 'Off'
    case 'browser':
      return BROWSER_LABELS[value as Browser]
    case 'defaultPostMode':
      return value === 'comment' ? 'Comment' : 'Request changes'
    case 'reviewTimeoutMinutes':
      return `${value} minutes`
    case 'model':
      return (value as string) || 'Claude Code default'
    default:
      return String(value)
  }
}

export interface SettingChange {
  key: keyof Settings
  label: string
  from: string
  to: string
}

/** What "Restore defaults" would change, in display order. */
export function diffSettings(
  current: Settings,
  next: Settings = DEFAULT_SETTINGS
): SettingChange[] {
  return (Object.keys(LABELS) as (keyof Settings)[])
    .filter((key) => current[key] !== next[key])
    .map((key) => ({
      key,
      label: LABELS[key],
      from: settingText(key, current[key]),
      to: settingText(key, next[key])
    }))
}

/**
 * Model and timeout for a new review. A model set in Settings wins; blank falls back to the
 * legacy PR_HUB_MODEL variable, then to Claude Code's own default (undefined).
 */
export function reviewRunSettings(
  settings: Settings,
  envModel: string | undefined
): { model: string | undefined; timeoutMs: number } {
  const fromEnv = normalizeModel(envModel)
  return {
    model: settings.model || fromEnv || undefined,
    timeoutMs: settings.reviewTimeoutMinutes * 60 * 1000
  }
}
