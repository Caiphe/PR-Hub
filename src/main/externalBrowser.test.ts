import { describe, expect, it, vi } from 'vitest'
import { installedBrowsers, isWebUrl, openExternal, type ExecFile } from './externalBrowser'

const url = 'https://github.com/owner/repo/pull/123'
const ok = (): ExecFile => vi.fn<ExecFile>((_file, _args, callback) => callback(null))

describe('openExternal', () => {
  it.each([
    ['firefox', 'org.mozilla.firefox'],
    ['chrome', 'com.google.Chrome']
  ] as const)('opens %s by bundle id with an argument array', async (browser, bundleId) => {
    const execFile = ok()
    const system = vi.fn(async () => undefined)
    expect(await openExternal(url, browser, system, 'darwin', execFile)).toEqual({
      opened: browser
    })
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-b', bundleId, url],
      expect.any(Function)
    )
    expect(system).not.toHaveBeenCalled()
  })

  it('uses the system browser for System default without spawning anything', async () => {
    const execFile = ok()
    const system = vi.fn(async () => undefined)
    expect(await openExternal(url, 'system', system, 'darwin', execFile)).toEqual({
      opened: 'system'
    })
    expect(execFile).not.toHaveBeenCalled()
    expect(system).toHaveBeenCalledWith(url)
  })

  it('falls back to the system browser and says so when the browser is missing', async () => {
    const execFile = vi.fn<ExecFile>((_file, _args, callback) =>
      callback(new Error('Unable to find application with identifier'))
    )
    const system = vi.fn(async () => undefined)
    expect(await openExternal(url, 'chrome', system, 'darwin', execFile)).toEqual({
      opened: 'system',
      fallbackFrom: 'chrome'
    })
    expect(system).toHaveBeenCalledWith(url)
  })

  it('uses the system browser on other platforms', async () => {
    const execFile = ok()
    const system = vi.fn(async () => undefined)
    await openExternal(url, 'firefox', system, 'linux', execFile)
    expect(execFile).not.toHaveBeenCalled()
    expect(system).toHaveBeenCalledWith(url)
  })

  it('refuses anything that is not a plain web link, before launching anything', async () => {
    const execFile = ok()
    const system = vi.fn(async () => undefined)
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'x-apple.systempreferences:',
      '-a Calculator',
      'https://user:pass@github.com/',
      'https://github.com/a b',
      'https://github.com/\nx',
      'https://',
      ''
    ]) {
      await expect(openExternal(bad, 'firefox', system, 'darwin', execFile)).rejects.toThrow()
    }
    expect(execFile).not.toHaveBeenCalled()
    expect(system).not.toHaveBeenCalled()
  })
})

describe('isWebUrl', () => {
  it('accepts http and https links', () => {
    expect(isWebUrl(url)).toBe(true)
    expect(isWebUrl('http://localhost:5173/x?y=1#z')).toBe(true)
    expect(isWebUrl('https://github.com/a/%E2%9C%93')).toBe(true)
  })
})

describe('installedBrowsers', () => {
  it('looks in both Applications folders on macOS', () => {
    const paths = new Set(['/Applications/Firefox.app', '/Users/me/Applications/Google Chrome.app'])
    expect(installedBrowsers('darwin', (p) => paths.has(p), '/Users/me')).toEqual({
      system: true,
      firefox: true,
      chrome: true
    })
    expect(installedBrowsers('darwin', () => false, '/Users/me')).toEqual({
      system: true,
      firefox: false,
      chrome: false
    })
  })

  it('reports only the system browser elsewhere', () => {
    expect(installedBrowsers('linux', () => true, '/home/me')).toEqual({
      system: true,
      firefox: false,
      chrome: false
    })
  })
})
