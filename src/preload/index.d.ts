import type { PrHubApi } from '../shared/ipc'

declare global {
  interface Window {
    api: PrHubApi
  }
}
