import { describe, expect, it } from 'vitest'
import { childEnv } from './environment'
import { allowedTools, buildArgs } from './reviewRunner'

const skill = { skillDir: '/skills/pr-review', skillMarkdown: '# PR Review' }

describe('buildArgs', () => {
  it('restricts tools and never prompts for permission', () => {
    const args = buildArgs({ skill })
    expect(args).toContain('-p')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read Grep Glob Bash')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps --allowedTools last so its variadic values are not mixed with other flags', () => {
    const args = buildArgs({ skill, model: 'sonnet' })
    const i = args.indexOf('--allowedTools')
    expect(args.slice(i + 1)).toEqual(allowedTools(skill.skillDir))
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
  })

  it('allows only the skill fetch script and read-only git/gh commands', () => {
    const fetchRule = 'Bash(bash /skills/pr-review/scripts/fetch_pr.sh:*)'
    const bash = allowedTools('/skills/pr-review').filter((t) => t.startsWith('Bash('))
    expect(bash).toContain(fetchRule)
    for (const rule of bash.filter((r) => r !== fetchRule)) {
      expect(rule).not.toMatch(/push|commit|merge|gh api|review|comment|Bash\(bash:\*\)/)
    }
  })
})

describe('childEnv', () => {
  it('drops nested-session and Electron variables and sets PATH', () => {
    const env = childEnv(
      {
        HOME: '/Users/me',
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'x',
        CLAUDE_CODE_OAUTH_TOKEN: 'keep-me'
      },
      '/opt/homebrew/bin:/usr/bin'
    )
    expect(env).toEqual({
      HOME: '/Users/me',
      PATH: '/opt/homebrew/bin:/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep-me'
    })
  })
})
