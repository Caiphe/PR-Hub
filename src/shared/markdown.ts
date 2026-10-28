// Markdown helpers shared by the review UI and the GitHub poster.

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

// Makes model-written markdown safe to post on GitHub. Review text is partly derived from
// untrusted PR content, so outside code:
//  - @user and @org/team get a zero-width space after the @ so they can't ping anyone;
//  - `<` is escaped so raw HTML can't render or hide text (e.g. `<!-- secret -->` would be
//    invisible in the preview but present in the posted comment).
// Code spans and fenced blocks are left alone: neither fires there, and suggestions must stay
// byte-exact (e.g. Python decorators, generics). A backslash-escaped backtick is literal text
// on GitHub, so it doesn't open a code span here either.
const CODE = /(`{3,})[\s\S]*?\1|(?<!\\)`[^`\n]*(?<!\\)`/g

export function sanitizeForGitHub(markdown: string): string {
  let out = ''
  let last = 0
  for (const match of markdown.matchAll(CODE)) {
    out += sanitizeText(markdown.slice(last, match.index)) + match[0]
    last = match.index! + match[0].length
  }
  return out + sanitizeText(markdown.slice(last))
}

function sanitizeText(text: string): string {
  return text.replace(/</g, '&lt;').replace(/(^|[^\w])@([A-Za-z0-9][\w-]*)/g, '$1@\u200b$2')
}

// Imperative English at the start ("Add a guard: ...", "Consider using ...") means the model put
// advice where code belongs. Best-effort backstop for the prompt's "code only" rule.
const PROSE_START =
  /^(add|use|replace|consider|move|remove|change|wrap|check|ensure|make|guard|escape|call|rename|extract|validate|handle|avoid|prefer|switch|update|insert|delete|refactor|return early|either|instead|you)\b[^\S\n]+[a-z]/i

export function looksLikeProse(code: string): boolean {
  return PROSE_START.test(code.trim())
}
