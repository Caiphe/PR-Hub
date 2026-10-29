import { describe, expect, it, vi } from 'vitest'
import { openExternalInFirefox, type ExecFile } from './externalBrowser'

const url = 'https://github.com/owner/repo/pull/123'

describe('openExternalInFirefox', () => {
  it('opens links in Firefox by bundle ID on macOS', async () => {
    const execFile = vi.fn<ExecFile>((_file, _args, callback) => callback(null))
    const fallback = vi.fn(async () => undefined)

    await openExternalInFirefox(url, fallback, 'darwin', execFile)

    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-b', 'org.mozilla.firefox', url],
      expect.any(Function)
    )
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when Firefox cannot be opened', async () => {
    const execFile = vi.fn<ExecFile>((_file, _args, callback) =>
      callback(new Error('Firefox is unavailable'))
    )
    const fallback = vi.fn(async () => undefined)

    await openExternalInFirefox(url, fallback, 'darwin', execFile)

    expect(fallback).toHaveBeenCalledWith(url)
  })

  it('uses the system browser on non-macOS platforms', async () => {
    const execFile = vi.fn<ExecFile>()
    const fallback = vi.fn(async () => undefined)

    await openExternalInFirefox(url, fallback, 'linux', execFile)

    expect(execFile).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledWith(url)
  })
})
