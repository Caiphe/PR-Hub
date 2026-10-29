import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { rm, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type { HistoryEntry, HistorySummary } from '../shared/history'
import { overrideChoices, type Override } from '../shared/incremental'
import { summarize } from '../shared/history'
import {
  IPC,
  type DeleteHistoryResult,
  type ExportHistoryResult,
  type HistoryExportFormat
} from '../shared/ipc'
import { parsePrUrl } from '../shared/validate'
import { exportFileName, exportJson, exportMarkdown } from './historyExport'
import { handle } from './ipcGuard'
import { getHistory, reviewsDir } from './reviewIpc'

// Pin, delete and export for saved reviews. Everything here is local: nothing touches GitHub.
// Confirmation (delete) and the file location (export) are asked in native dialogs owned by
// the main process, so the renderer can't skip them or pick a path.

const isId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)

const windowOf = (sender: WebContents): BrowserWindow | undefined =>
  BrowserWindow.fromWebContents(sender) ?? undefined

export async function setPinned(id: unknown, pinned: unknown): Promise<HistorySummary | null> {
  if (!isId(id)) return null
  const entry = await getHistory().setPinned(id, pinned === true)
  return entry ? summarize(entry) : null
}

/**
 * Settles an uncertain comparison item locally, or clears it (value null). Only uncertain
 * items accept an override, and only the values their side allows. Never touches GitHub.
 */
export async function setOverride(
  id: unknown,
  key: unknown,
  value: unknown
): Promise<HistoryEntry | null> {
  if (!isId(id) || typeof key !== 'string') return null
  return getHistory().update(id, (entry) => {
    const item = entry.incremental?.comparison?.items.find((i) => i.key === key)
    if (!item) return entry
    const overrides = { ...entry.overrides }
    if (value === null) delete overrides[key]
    else if (overrideChoices(item).includes(value as Override)) overrides[key] = value as Override
    else return entry
    const next: HistoryEntry = { ...entry, overrides }
    if (Object.keys(overrides).length === 0) next.overrides = undefined
    return next
  })
}

export async function deleteReview(sender: WebContents, id: unknown): Promise<DeleteHistoryResult> {
  if (!isId(id)) return 'missing'
  const entry = await getHistory().get(id)
  if (!entry) return 'missing'
  const ref = parsePrUrl(entry.input.prUrl)
  const label = ref ? `${ref.owner}/${ref.repo}#${ref.number}` : 'the PR'
  const win = windowOf(sender)
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Delete this review from PR Hub?',
    detail: `"${entry.input.title}" (${label}) and its saved files are removed from this Mac. Anything already posted to GitHub stays there.`
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return 'cancelled'

  if (!(await getHistory().remove(id))) return 'missing'
  // The id was checked above, so this stays inside the reviews folder.
  await rm(join(reviewsDir(), id), { recursive: true, force: true }).catch((error) =>
    console.error('Deleted the review but not its folder', error)
  )
  return 'deleted'
}

export async function exportReview(
  sender: WebContents,
  id: unknown,
  format: unknown
): Promise<ExportHistoryResult> {
  const kind: HistoryExportFormat = format === 'json' ? 'json' : 'markdown'
  const entry = isId(id) ? await getHistory().get(id) : null
  if (!entry) return { status: 'failed', error: 'That review is no longer in history.' }

  const win = windowOf(sender)
  const options: Electron.SaveDialogOptions = {
    title: kind === 'json' ? 'Export review as JSON' : 'Export review as Markdown',
    defaultPath: join(app.getPath('downloads'), exportFileName(entry, kind)),
    filters:
      kind === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    // The save panel asks before replacing an existing file.
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }
  const choice = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) return { status: 'cancelled' }

  try {
    await writeFile(choice.filePath, kind === 'json' ? exportJson(entry) : exportMarkdown(entry))
    return { status: 'saved', fileName: basename(choice.filePath) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    console.error('Export failed', error)
    return { status: 'failed', error: `Couldn't save the file${code ? ` (${code})` : ''}.` }
  }
}

export function registerHistoryIpc(): void {
  handle(IPC.setHistoryPinned, (_e, id, pinned) => setPinned(id, pinned))
  handle(IPC.setOverride, (_e, id, key, value) => setOverride(id, key, value))
  handle(IPC.deleteHistory, (e, id) => deleteReview(e.sender, id))
  handle(IPC.exportHistory, (e, id, format) => exportReview(e.sender, id, format))
}
