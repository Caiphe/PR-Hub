import { readFile, rename, writeFile } from 'fs/promises'
import {
  HistoryEntrySchema,
  summarize,
  type HistoryEntry,
  type HistorySummary
} from '../shared/history'

export const HISTORY_LIMIT = 50
const FILE_VERSION = 1

interface HistoryFile {
  version: number
  entries: HistoryEntry[]
}

// Review history in one JSON file, newest first. Writes go to a temp file and are
// renamed into place, so a crash mid-write never leaves a half-written history.
// Each read-modify-write runs in a queue so concurrent finishes can't drop each other's entries.
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private loaded: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly limit = HISTORY_LIMIT
  ) {}

  private async load(): Promise<HistoryEntry[]> {
    this.loaded ??= this.readFromDisk()
    await this.loaded
    return this.entries
  }

  private async readFromDisk(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return // First run.
    }

    let parsed: Partial<HistoryFile>
    try {
      parsed = JSON.parse(raw)
      if (!Array.isArray(parsed.entries)) throw new Error('missing entries array')
    } catch (error) {
      // Keep the unreadable file for inspection rather than silently overwriting it.
      const backup = `${this.file}.corrupt-${Date.now()}`
      await rename(this.file, backup).catch(() => {})
      console.error(`History file unreadable (${(error as Error).message}); moved to ${backup}`)
      return
    }

    // One bad entry shouldn't cost the rest of the history.
    this.entries = parsed.entries.flatMap((entry) => {
      const result = HistoryEntrySchema.safeParse(entry)
      return result.success ? [result.data] : []
    })
  }

  private async persist(): Promise<void> {
    const body: HistoryFile = { version: FILE_VERSION, entries: this.entries }
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(body))
    await rename(tmp, this.file)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  async list(): Promise<HistorySummary[]> {
    return (await this.load()).map(summarize)
  }

  async get(id: string): Promise<HistoryEntry | null> {
    return (await this.load()).find((e) => e.id === id) ?? null
  }

  async ids(): Promise<Set<string>> {
    return new Set((await this.load()).map((e) => e.id))
  }

  /** Adds an entry (newest first) and returns the ids trimmed off the end. */
  add(entry: HistoryEntry): Promise<string[]> {
    return this.enqueue(async () => {
      const current = await this.load()
      const next = [entry, ...current.filter((e) => e.id !== entry.id)]
      const removed = next.slice(this.limit).map((e) => e.id)
      this.entries = next.slice(0, this.limit)
      await this.persist()
      return removed
    })
  }
}
