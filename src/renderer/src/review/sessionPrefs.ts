import type { GroupMode } from './findingsView'
import { NO_HISTORY_FILTERS, type HistoryFilters } from './historyView'

// Choices remembered while the app runs (not saved to disk; persistent settings come later).
let groupMode: GroupMode = 'severity'
// Kept so opening a review from History and coming back doesn't lose the search.
let historyFilters: HistoryFilters = NO_HISTORY_FILTERS

export const sessionPrefs = {
  get groupMode(): GroupMode {
    return groupMode
  },
  set groupMode(mode: GroupMode) {
    groupMode = mode
  },
  get historyFilters(): HistoryFilters {
    return historyFilters
  },
  set historyFilters(filters: HistoryFilters) {
    historyFilters = filters
  }
}
