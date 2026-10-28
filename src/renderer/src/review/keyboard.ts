/** True while a modal dialog owns the keyboard (it handles its own Esc). */
export function dialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null
}
