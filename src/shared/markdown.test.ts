import { describe, expect, it } from 'vitest'
import { neutralizeMentions } from './markdown'

const ZWSP = '​'

describe('neutralizeMentions', () => {
  it('breaks @user and @org/team mentions in prose', () => {
    expect(neutralizeMentions('ping @octocat and @acme/core')).toBe(
      `ping @${ZWSP}octocat and @${ZWSP}acme/core`
    )
    expect(neutralizeMentions('@lead please look')).toBe(`@${ZWSP}lead please look`)
  })

  it('leaves emails alone', () => {
    expect(neutralizeMentions('mail me@example.com')).toBe('mail me@example.com')
  })

  it('does not touch inline code or fenced blocks', () => {
    const md = 'use `@Input()` here\n\n```suggestion\n@property\ndef x(self): ...\n```\nthen @dev'
    expect(neutralizeMentions(md)).toBe(
      `use \`@Input()\` here\n\n\`\`\`suggestion\n@property\ndef x(self): ...\n\`\`\`\nthen @${ZWSP}dev`
    )
  })

  it('handles longer fences that contain triple backticks', () => {
    const md = '````\nconst s = ```@x```\n````\n@y'
    expect(neutralizeMentions(md)).toBe(`\`\`\`\`\nconst s = \`\`\`@x\`\`\`\n\`\`\`\`\n@${ZWSP}y`)
  })
})
