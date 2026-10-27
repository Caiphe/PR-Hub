import { describe, expect, it } from 'vitest'
import { buildPrompt, buildSystemPrompt } from './prompt'

const input = {
  title: 'Fix login redirect',
  prUrl: 'https://github.com/acme/web/pull/42',
  description: 'After login, users land on the page they came from.'
}
const ctx = { skillDir: '/skills/pr-review', workDir: '/data/reviews/abc' }

describe('buildPrompt', () => {
  it('matches the snapshot', () => {
    expect(buildPrompt(input, ctx)).toMatchSnapshot()
  })

  it('includes the task, the exact fetch command and the JSON contract', () => {
    const prompt = buildPrompt(input, ctx)
    expect(prompt).toContain(input.description)
    expect(prompt).toContain(
      'bash /skills/pr-review/scripts/fetch_pr.sh https://github.com/acme/web/pull/42 /data/reviews/abc/pr'
    )
    expect(prompt).toContain('untrusted data')
    expect(prompt).toMatch(/```json\n\{\n {2}"verdict"/)
  })
})

describe('buildSystemPrompt', () => {
  it('strips frontmatter and fills in the skill directory', () => {
    const skillMarkdown =
      '---\nname: pr-review\n---\n\n# PR Review\nRun bash <skill-dir>/scripts/fetch_pr.sh'
    const system = buildSystemPrompt({ skillDir: '/skills/pr-review', skillMarkdown })
    expect(system).not.toContain('name: pr-review')
    expect(system).toContain('Run bash /skills/pr-review/scripts/fetch_pr.sh')
    expect(system).not.toContain('<skill-dir>')
  })
})
