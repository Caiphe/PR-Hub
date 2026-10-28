import { describe, expect, it } from 'vitest'
import { sanitizeForGitHub } from './markdown'

const ZWSP = '​'

describe('sanitizeForGitHub', () => {
  it('breaks @user and @org/team mentions in prose', () => {
    expect(sanitizeForGitHub('ping @octocat and @acme/core')).toBe(
      `ping @${ZWSP}octocat and @${ZWSP}acme/core`
    )
    expect(sanitizeForGitHub('@lead please look')).toBe(`@${ZWSP}lead please look`)
  })

  it('leaves emails alone', () => {
    expect(sanitizeForGitHub('mail me@example.com')).toBe('mail me@example.com')
  })

  it('does not touch inline code or fenced blocks', () => {
    const md = 'use `@Input()` here\n\n```suggestion\n@property\ndef x(self): ...\n```\nthen @dev'
    expect(sanitizeForGitHub(md)).toBe(
      `use \`@Input()\` here\n\n\`\`\`suggestion\n@property\ndef x(self): ...\n\`\`\`\nthen @${ZWSP}dev`
    )
  })

  it('treats backslash-escaped backticks as text, not code', () => {
    expect(sanitizeForGitHub('see \\`@org/team\\` now')).toBe(`see \\\`@${ZWSP}org/team\\\` now`)
  })

  it('escapes raw HTML outside code but not inside it', () => {
    expect(sanitizeForGitHub('ok <!-- token: abc --> <img src=x>')).toBe(
      'ok &lt;!-- token: abc --> &lt;img src=x>'
    )
    expect(sanitizeForGitHub('use `Vec<u8>` and\n```ts\nconst a: Array<string> = []\n```')).toBe(
      'use `Vec<u8>` and\n```ts\nconst a: Array<string> = []\n```'
    )
  })

  it('handles longer fences that contain triple backticks', () => {
    const md = '````\nconst s = ```@x```\n````\n@y'
    expect(sanitizeForGitHub(md)).toBe(`\`\`\`\`\nconst s = \`\`\`@x\`\`\`\n\`\`\`\`\n@${ZWSP}y`)
  })
})
