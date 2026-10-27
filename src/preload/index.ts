import { contextBridge } from 'electron'

// The renderer's only door to the main process. Sandboxed preloads can only
// import 'electron', so keep this file free of other runtime dependencies.
// Methods are added here as IPC channels from src/shared/ipc.ts are implemented.
const api = {}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
