import { FindingsSchema, type Findings } from '../shared/findings'

export interface Extracted {
  markdown: string
  findings: Findings | null
  findingsError?: string
}

// Matches ```json fenced blocks. The reviewer is told to put exactly one at the end,
// but the review itself may quote JSON, so the last block wins.
const JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)\n```/g

const REVIEW_HEADING = /^## PR review/m

// The final message often opens with narration ("Let me now write the review.") and
// separates sections with ---. Keep the review from its heading on, without edge rules.
export function cleanReviewMarkdown(text: string): string {
  const start = text.search(REVIEW_HEADING)
  return (start > 0 ? text.slice(start) : text)
    .trim()
    .replace(/^(?:-{3,}\s*\n)+/, '')
    .replace(/(?:\n\s*-{3,})+$/, '')
    .trim()
}

// Never throws: a bad or missing block degrades to a markdown-only review.
export function extractFindings(resultText: string): Extracted {
  const blocks = [...resultText.matchAll(JSON_FENCE)]
  const last = blocks.at(-1)
  if (!last || last.index === undefined) {
    return {
      markdown: cleanReviewMarkdown(resultText),
      findings: null,
      findingsError: 'No findings block found'
    }
  }

  const markdown = cleanReviewMarkdown(
    resultText.slice(0, last.index) + resultText.slice(last.index + last[0].length)
  )

  let raw: unknown
  try {
    raw = JSON.parse(last[1])
  } catch (error) {
    return {
      markdown,
      findings: null,
      findingsError: `Findings block is not valid JSON: ${(error as Error).message}`
    }
  }

  const parsed = FindingsSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      markdown,
      findings: null,
      findingsError: `Findings block doesn't match the schema: ${issue.path.join('.')} ${issue.message}`
    }
  }
  return { markdown, findings: parsed.data }
}
