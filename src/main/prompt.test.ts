import { describe, expect, it } from 'vitest'
import { buildPrompt, buildSystemPrompt } from './prompt'

const input = {
  title: 'Fix login redirect',
  prUrl: 'https://github.com/acme/web/pull/42',
  description: 'After login, users land on the page they came from.'
}
const ctx = { workDir: '/data/reviews/abc', fetchLog: 'files changed: 2   diff lines: 82' }

describe('buildPrompt', () => {
  it('matches the snapshot', () => {
    expect(buildPrompt(input, ctx)).toMatchSnapshot()
  })

  it('includes the task, the fetch log, the scope limits and the JSON contract', () => {
    const prompt = buildPrompt(input, ctx)
    expect(prompt).toContain(input.description)
    expect(prompt).toContain('<fetch-log>\nfiles changed: 2   diff lines: 82\n</fetch-log>')
    expect(prompt).toContain("Don't run it again")
    expect(prompt).toContain('You can only read files inside /data/reviews/abc')
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
