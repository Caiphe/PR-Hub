import { readFile, rename, writeFile } from 'fs/promises'
import {
  HistoryEntrySchema,
  summarize,
  type HistoryEntry,
  type HistorySummary
} from '../shared/history'

export const HISTORY_LIMIT = 50
/**
 * 1: entries without `pinned`. 2: entries may be pinned. Version 1 entries are valid version 2
 * entries, so reading needs no conversion; the number tells older builds what wrote the file.
 */
export const FILE_VERSION = 2

const KNOWN_KEYS = new Set(Object.keys(HistoryEntrySchema.shape))

export interface ParsedHistory {
  entries: HistoryEntry[]
  /** Top-level fields this build doesn't know (written by a newer version), per entry id. */
  extras: Map<string, Record<string, unknown>>
  /** Entries this build can't parse, kept as-is. */
  unreadable: unknown[]
}

/**
 * Reads any history file shape: `{version, entries}` (versions 1, 2, or newer) or a bare array.
 * Returns null when the data isn't history at all. Never throws for a bad entry: one bad entry
 * shouldn't cost the rest of the history.
 */
export function parseHistoryFile(data: unknown): ParsedHistory | null {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries)
      ? (data as { entries: unknown[] }).entries
      : null
  if (!list) return null

  const parsed: ParsedHistory = { entries: [], extras: new Map(), unreadable: [] }
  const seen = new Set<string>()
  for (const raw of list) {
    const result = HistoryEntrySchema.safeParse(raw)
    // A repeated id would make get/update/delete ambiguous; keep the first, preserve the rest.
    if (!result.success || seen.has(result.data.id)) {
      parsed.unreadable.push(raw)
      continue
    }
    seen.add(result.data.id)
    parsed.entries.push(result.data)
    const extra = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([key]) => !KNOWN_KEYS.has(key))
    )
    if (Object.keys(extra).length > 0) parsed.extras.set(result.data.id, extra)
  }
  return parsed
}

/** Keeps every pinned entry plus the newest `limit` unpinned ones (input is newest first). */
export function applyRetention(
  entries: HistoryEntry[],
  limit: number
): { kept: HistoryEntry[]; removed: string[] } {
  const kept: HistoryEntry[] = []
  const removed: string[] = []
  let unpinned = 0
  for (const entry of entries) {
    if (entry.pinned || unpinned++ < limit) kept.push(entry)
    else removed.push(entry.id)
  }
  return { kept, removed }
}

// Review history in one JSON file, newest first. Writes go to a temp file and are
// renamed into place, so a crash mid-write never leaves a half-written history, and the
// in-memory copy only changes once the write succeeded.
// Each read-modify-write runs in a queue so concurrent finishes can't drop each other's entries.
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private extras = new Map<string, Record<string, unknown>>()
  // Entries this build can't parse (e.g. written by a newer version). Kept as-is and written
  // back, so a schema change or downgrade never silently deletes history.
  private unreadable: unknown[] = []
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

    let parsed: ParsedHistory | null
    try {
      parsed = parseHistoryFile(JSON.parse(raw))
      if (!parsed) throw new Error('missing entries array')
    } catch (error) {
      // Keep the unreadable file for inspection rather than silently overwriting it.
      const backup = `${this.file}.corrupt-${Date.now()}`
      await rename(this.file, backup).catch(() => {})
      console.error(`History file unreadable (${(error as Error).message}); moved to ${backup}`)
      return
    }

    this.entries = parsed.entries
    this.extras = parsed.extras
    this.unreadable = parsed.unreadable
    if (this.unreadable.length > 0) {
      console.error(
        `History: ${this.unreadable.length} entries couldn't be read and were kept as-is`
      )
    }
  }

  private async commit(entries: HistoryEntry[]): Promise<void> {
    const body = {
      version: FILE_VERSION,
      entries: [...entries.map((e) => ({ ...this.extras.get(e.id), ...e })), ...this.unreadable]
    }
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(body))
    await rename(tmp, this.file)
    this.entries = entries
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

  /** Ids of every saved entry, including ones this build can't read (their folders stay). */
  async ids(): Promise<Set<string>> {
    const readable = (await this.load()).map((e) => e.id)
    const other = this.unreadable.flatMap((e) => {
      const id = (e as { id?: unknown } | null)?.id
      return typeof id === 'string' ? [id] : []
    })
    return new Set([...readable, ...other])
  }

  /**
   * Adds an entry (newest first) and returns the ids trimmed off the end. Pinned entries are
   * never trimmed and don't count towards the limit.
   */
  add(entry: HistoryEntry): Promise<string[]> {
    return this.enqueue(async () => {
      const current = await this.load()
      const { kept, removed } = applyRetention(
        [entry, ...current.filter((e) => e.id !== entry.id)],
        this.limit
      )
      await this.commit(kept)
      removed.forEach((id) => this.extras.delete(id))
      return removed
    })
  }

  /** Replaces one entry in place (keeping its position); returns the new entry, or null if gone. */
  update(id: string, change: (entry: HistoryEntry) => HistoryEntry): Promise<HistoryEntry | null> {
    return this.enqueue(async () => {
      const current = await this.load()
      const index = current.findIndex((e) => e.id === id)
      if (index === -1) return null
      const updated = change(current[index])
      await this.commit(current.map((e, i) => (i === index ? updated : e)))
      return updated
    })
  }

  /** Pins or unpins an entry. Unpinning doesn't trim right away; the next saved review does. */
  setPinned(id: string, pinned: boolean): Promise<HistoryEntry | null> {
    return this.update(id, (entry) => {
      const next = { ...entry }
      if (pinned) next.pinned = true
      else delete next.pinned
      return next
    })
  }

  /** Removes an entry; returns false if there was none. */
  remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const current = await this.load()
      if (!current.some((e) => e.id === id)) return false
      await this.commit(current.filter((e) => e.id !== id))
      this.extras.delete(id)
      return true
    })
  }
}
