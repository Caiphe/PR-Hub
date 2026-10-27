import { relative, isAbsolute } from 'path'
import type { ReviewEventBody } from '../shared/ipc'

// Maps `claude -p --output-format stream-json --verbose` lines to app events.
// Each stdout line is one JSON object; the shapes used here are:
//   {type:'system', subtype:'init', ...}
//   {type:'assistant', message:{content:[{type:'text'|'tool_use'|'thinking', ...}]}}
//   {type:'result', subtype:'success'|'error_*', is_error, result, total_cost_usd,
//    duration_ms, permission_denials:[{tool_name, tool_input}]}
// Everything else (thinking_tokens, rate limits, tool results) is ignored.

export interface StreamResult {
  isError: boolean
  text: string
  costUsd: number | null
  durationMs: number
  deniedTools: string[]
}

export type ParsedLine =
  { kind: 'event'; event: ReviewEventBody } | { kind: 'result'; result: StreamResult }

interface ParseContext {
  workDir: string
}

const MAX_LABEL = 80

function truncate(text: string, max = MAX_LABEL): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function displayPath(path: unknown, ctx: ParseContext): string {
  if (typeof path !== 'string') return ''
  if (!isAbsolute(path)) return path
  const rel = relative(ctx.workDir, path)
  if (rel.startsWith('..')) return path
  // Files from the checked-out PR live under <workDir>/pr/repo/.
  return rel.replace(/^pr\/repo\//, '').replace(/^pr\//, '')
}

export function toolLabel(name: string, input: Record<string, unknown>, ctx: ParseContext): string {
  switch (name) {
    case 'Bash': {
      const command = String(input.command ?? '')
      if (command.includes('fetch_pr.sh')) return 'Fetching the PR'
      return truncate(`Running ${String(input.description ?? command)}`)
    }
    case 'Read':
      return truncate(`Reading ${displayPath(input.file_path, ctx)}`)
    case 'Grep':
      return truncate(`Searching for "${String(input.pattern ?? '')}"`)
    case 'Glob':
      return truncate(`Listing ${String(input.pattern ?? '')}`)
    default:
      return name
  }
}

function denialLabel(denial: unknown): string {
  const d = denial as { tool_name?: string; tool_input?: { command?: string } }
  const name = d.tool_name ?? 'unknown'
  return d.tool_input?.command ? `${name}(${truncate(d.tool_input.command, 120)})` : name
}

export function parseStreamLine(line: string, ctx: ParseContext): ParsedLine[] {
  if (!line.trim()) return []
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return []
  }

  if (msg.type === 'system' && msg.subtype === 'init') {
    return [{ kind: 'event', event: { type: 'status', message: 'Review session started' } }]
  }

  if (msg.type === 'assistant') {
    const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? []
    const out: ParsedLine[] = []
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        const name = String(block.name)
        const input = (block.input ?? {}) as Record<string, unknown>
        out.push({
          kind: 'event',
          event: { type: 'tool', tool: name, label: toolLabel(name, input, ctx) }
        })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'event', event: { type: 'text', text: block.text } })
      }
    }
    return out
  }

  if (msg.type === 'result') {
    const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials : []
    return [
      {
        kind: 'result',
        result: {
          isError: msg.is_error === true || msg.subtype !== 'success',
          text: typeof msg.result === 'string' ? msg.result : '',
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
          deniedTools: [...new Set(denials.map(denialLabel))]
        }
      }
    ]
  }

  return []
}
