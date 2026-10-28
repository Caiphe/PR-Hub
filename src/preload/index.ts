import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type PrHubApi, type ReviewEvent } from '../shared/ipc'

// The renderer's only door to the main process. Sandboxed preloads can only require
// 'electron' at runtime; local imports like ../shared are fine because they're bundled in.
const api: PrHubApi = {
  startReview: (input) => ipcRenderer.invoke(IPC.startReview, input),
  cancelReview: (reviewId) => ipcRenderer.invoke(IPC.cancelReview, reviewId),
  onReviewEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: ReviewEvent): void => listener(payload)
    ipcRenderer.on(IPC.reviewEvent, handler)
    return () => ipcRenderer.removeListener(IPC.reviewEvent, handler)
  },
  listHistory: () => ipcRenderer.invoke(IPC.listHistory),
  getHistory: (id) => ipcRenderer.invoke(IPC.getHistory, id),
  previewPost: (reviewId, findingIds, mode) =>
    ipcRenderer.invoke(IPC.previewPost, reviewId, findingIds, mode),
  post: (previewId) => ipcRenderer.invoke(IPC.post, previewId),
  replayFixture: (variant) => ipcRenderer.invoke(IPC.replayFixture, variant)
}

contextBridge.exposeInMainWorld('api', api)
