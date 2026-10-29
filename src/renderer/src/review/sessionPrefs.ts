import type { GroupMode } from './findingsView'

// Choices remembered while the app runs (not saved to disk; persistent settings come later).
let groupMode: GroupMode = 'severity'

export const sessionPrefs = {
  get groupMode(): GroupMode {
    return groupMode
  },
  set groupMode(mode: GroupMode) {
    groupMode = mode
  }
}
