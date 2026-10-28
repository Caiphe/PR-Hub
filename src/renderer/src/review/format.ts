import { parsePrUrl } from '@shared/validate'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}

export function formatCost(usd: number | null): string | null {
  if (usd === null) return null
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function prLabel(url: string): string {
  const ref = parsePrUrl(url)
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}` : url
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  php: 'php',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql'
}

/** highlight.js language for a file path, or '' when unknown. */
export function languageForFile(path: string | null | undefined): string {
  const ext = path?.split('.').pop()?.toLowerCase()
  return (ext && LANGUAGES[ext]) || ''
}

/** Wraps code in a markdown fence long enough that backticks inside can't close it early. */
export function codeFence(code: string, language = ''): string {
  const longestRun = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}`
}
