// Renders the SVG icon sources to PNGs with Electron's own Chromium, then builds the
// macOS .icns with iconutil. Run after editing resources/icons/*.svg:
//   npm run icons
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = (name) => readFileSync(join(root, 'resources/icons', name), 'utf8')

let win
const tmpHtml = join(tmpdir(), `pr-hub-icon-${process.pid}.html`)

// One offscreen window reused for every size; creating many in a row is flaky.
async function render(markup, size) {
  win ??= new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  win.setContentSize(size, size)
  const sized = markup.replace(
    '<svg ',
    `<svg width="${size}" height="${size}" style="display:block" `
  )
  writeFileSync(
    tmpHtml,
    `<html><body style="margin:0;background:transparent">${sized}</body></html>`
  )
  await win.loadFile(tmpHtml)
  await new Promise((r) => setTimeout(r, 120))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  // Offscreen capture may come back at device pixels; normalize to the requested size.
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // Menu-bar icon: black glyph on transparent; the "Template" suffix lets macOS tint it.
  const glyph = svg('glyph.svg')
  writeFileSync(join(root, 'resources/trayTemplate.png'), await render(glyph, 16))
  writeFileSync(join(root, 'resources/trayTemplate@2x.png'), await render(glyph, 32))

  // App icon: all iconset sizes, then .icns via iconutil, plus a 512px PNG for Linux/dev.
  const appSvg = svg('app.svg')
  const iconset = join(root, 'build/icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${size}x${size}.png`), await render(appSvg, size))
    writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), await render(appSvg, size * 2))
  }
  const big = await render(appSvg, 1024)
  writeFileSync(join(root, 'build/icon.png'), big)
  writeFileSync(join(root, 'resources/icon.png'), await render(appSvg, 512))
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build/icon.icns')])
  rmSync(iconset, { recursive: true, force: true })
  rmSync(tmpHtml, { force: true })
  console.log('icons written')
  app.quit()
})
