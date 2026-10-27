export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type SavedBounds = Partial<Rect>

export const DEFAULT_SIZE = { width: 440, height: 680 }
export const MIN_SIZE = { width: 380, height: 520 }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

// Returns the bounds to open the window with. Size is clamped to the minimum,
// and a saved position is dropped if it would land off every display (e.g. an
// external monitor was unplugged), so Electron centers the window instead.
export function resolveBounds(
  saved: SavedBounds | null | undefined,
  workAreas: Rect[]
): Partial<Rect> & { width: number; height: number } {
  const width = isFiniteNumber(saved?.width)
    ? Math.max(saved.width, MIN_SIZE.width)
    : DEFAULT_SIZE.width
  const height = isFiniteNumber(saved?.height)
    ? Math.max(saved.height, MIN_SIZE.height)
    : DEFAULT_SIZE.height

  if (!isFiniteNumber(saved?.x) || !isFiniteNumber(saved?.y)) return { width, height }

  const rect = { x: saved.x, y: saved.y, width, height }
  return workAreas.some((area) => intersects(rect, area)) ? rect : { width, height }
}
