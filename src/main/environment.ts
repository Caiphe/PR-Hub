import { execFile } from 'child_process'
import { constants } from 'fs'
import { access, readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import type { SkillContext } from './prompt'

export interface ReviewEnvironment {
  claudePath: string
  /** Environment for the claude child process (login-shell PATH, no inherited session vars). */
  env: NodeJS.ProcessEnv
}

const MARKER = '__PR_HUB_PATH__'

// GUI apps launched from Finder/Dock get a minimal PATH (/usr/bin:/bin:...), which
// misses Homebrew, nvm and ~/.local/bin, so ask the user's login shell for its PATH.
function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo ${MARKER}; echo "$PATH"`],
      { timeout: 10_000, env: { ...process.env, TERM: 'dumb' } },
      (error, stdout) => {
        if (error) return resolve(null)
        const after = stdout.split(MARKER)[1]
        resolve(after?.trim().split('\n')[0]?.trim() || null)
      }
    )
  })
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function findOnPath(binary: string, pathValue: string): Promise<string | null> {
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary)
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

// Variables that would make the child think it's nested in another Claude Code session
// or an Electron-as-Node process.
const STRIPPED_ENV =
  /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)$/

export function childEnv(base: NodeJS.ProcessEnv, pathValue: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!STRIPPED_ENV.test(key)) env[key] = value
  }
  env.PATH = pathValue
  return env
}

/** Environment for child processes (login-shell PATH plus common install folders). */
export async function resolveChildEnv(): Promise<NodeJS.ProcessEnv> {
  const home = homedir()
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.claude/local')
  ]
  const pathValue = [(await loginShellPath()) ?? process.env.PATH ?? '', ...extras]
    .filter(Boolean)
    .join(delimiter)
  return childEnv(process.env, pathValue)
}

export async function resolveReviewEnvironment(): Promise<ReviewEnvironment> {
  const env = await resolveChildEnv()
  const claudePath = await findOnPath('claude', env.PATH ?? '')
  if (!claudePath) {
    throw new Error(
      'Claude Code CLI not found. Install it (https://docs.claude.com/claude-code) and make sure `claude` is on your shell PATH.'
    )
  }
  return { claudePath, env }
}

async function findSkillDirs(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.name === 'pr-review' && (await stat(join(full, 'SKILL.md')).catch(() => null))) {
      found.push(full)
    } else {
      found.push(...(await findSkillDirs(full, depth - 1)))
    }
  }
  return found
}

// Finds the pr-review skill. PR_HUB_SKILL_DIR overrides; otherwise searches
// ~/.claude/skills (including claude.ai-synced skills) and picks the most recently updated copy.
export async function loadSkill(): Promise<SkillContext> {
  const override = process.env.PR_HUB_SKILL_DIR
  const candidates = override
    ? [override]
    : await findSkillDirs(join(homedir(), '.claude/skills'), 4)

  const withTimes = await Promise.all(
    candidates.map(async (dir) => ({
      dir,
      mtime: (await stat(join(dir, 'SKILL.md')).catch(() => null))?.mtimeMs ?? -1
    }))
  )
  const best = withTimes.filter((c) => c.mtime >= 0).sort((a, b) => b.mtime - a.mtime)[0]
  if (!best) {
    throw new Error(
      'pr-review skill not found under ~/.claude/skills. Install it, or set PR_HUB_SKILL_DIR to its folder.'
    )
  }
  return { skillDir: best.dir, skillMarkdown: await readFile(join(best.dir, 'SKILL.md'), 'utf8') }
}
