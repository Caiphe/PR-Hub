import { Menu, nativeImage, Tray } from 'electron'
import trayIcon from '../../resources/trayTemplate.png?asset'

export interface TrayActions {
  isVisible: () => boolean
  toggleWindow: () => void
  isPinned: () => boolean
  setPinned: (pinned: boolean) => void
  newReview: () => void
}

// Menu-bar icon: left click shows/hides the window, right click opens the menu.
// trayTemplate@2x.png next to the 1x file is picked up automatically on Retina screens.
export function createTray(actions: TrayActions): Tray {
  const image = nativeImage.createFromPath(trayIcon)
  image.setTemplateImage(true)
  const tray = new Tray(image)
  tray.setToolTip('PR Hub')

  const menu = (): Menu =>
    Menu.buildFromTemplate([
      {
        label: actions.isVisible() ? 'Hide PR Hub' : 'Show PR Hub',
        click: actions.toggleWindow
      },
      { label: 'New Review', click: actions.newReview },
      { type: 'separator' },
      {
        label: 'Keep on Top',
        type: 'checkbox',
        checked: actions.isPinned(),
        click: (item) => actions.setPinned(item.checked)
      },
      { type: 'separator' },
      { label: 'Quit PR Hub', role: 'quit' }
    ])

  tray.on('click', actions.toggleWindow)
  // Built on demand so labels and the checkbox always reflect current state.
  tray.on('right-click', () => tray.popUpContextMenu(menu()))

  return tray
}
