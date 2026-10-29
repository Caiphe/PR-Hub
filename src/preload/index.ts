import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type PrHubApi, type ReviewEvent, type Settings } from '../shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// The renderer's only door to the main process. Sandboxed preloads can only require
// 'electron' at runtime; local imports like ../shared are fine because they're bundled in.
const api: PrHubApi = {
  startReview: (input, options) => ipcRenderer.invoke(IPC.startReview, input, options),
  incrementalOffer: (prUrl, parentId) => ipcRenderer.invoke(IPC.incrementalOffer, prUrl, parentId),
  cancelReview: (reviewId) => ipcRenderer.invoke(IPC.cancelReview, reviewId),
  onReviewEvent: (listener) => subscribe<ReviewEvent>(IPC.reviewEvent, listener),
  listHistory: () => ipcRenderer.invoke(IPC.listHistory),
  getHistory: (id) => ipcRenderer.invoke(IPC.getHistory, id),
  setOverride: (id, key, value) => ipcRenderer.invoke(IPC.setOverride, id, key, value),
  setHistoryPinned: (id, pinned) => ipcRenderer.invoke(IPC.setHistoryPinned, id, pinned),
  deleteHistory: (id) => ipcRenderer.invoke(IPC.deleteHistory, id),
  exportHistory: (id, format) => ipcRenderer.invoke(IPC.exportHistory, id, format),
  previewPost: (reviewId, findingIds, mode) =>
    ipcRenderer.invoke(IPC.previewPost, reviewId, findingIds, mode),
  post: (previewId, options) =>
    ipcRenderer.invoke(IPC.post, previewId, { force: options?.force === true }),
  verifyPost: (previewId) => ipcRenderer.invoke(IPC.verifyPost, previewId),
  githubStatus: (prUrl) => ipcRenderer.invoke(IPC.githubStatus, prUrl),
  inspectPr: (prUrl) => ipcRenderer.invoke(IPC.inspectPr, prUrl),
  inspectIssue: (issueUrl) => ipcRenderer.invoke(IPC.inspectIssue, issueUrl),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setAlwaysOnTop: (pinned) => ipcRenderer.invoke(IPC.setAlwaysOnTop, pinned),
  updateSettings: (change) => ipcRenderer.invoke(IPC.updateSettings, change),
  restoreDefaultSettings: () => ipcRenderer.invoke(IPC.restoreSettings),
  browserStatus: () => ipcRenderer.invoke(IPC.browserStatus),
  onSettingsChanged: (listener) => subscribe<Settings>(IPC.settingsChanged, listener),
  onNewReview: (listener) => subscribe<void>(IPC.newReview, () => listener()),
  onOpenSettings: (listener) => subscribe<void>(IPC.openSettings, () => listener()),
  replayFixture: (variant) => ipcRenderer.invoke(IPC.replayFixture, variant)
}

contextBridge.exposeInMainWorld('api', api)
