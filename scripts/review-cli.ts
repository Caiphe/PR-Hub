// Runs a review from the terminal with the same runner the app uses (no Electron).
//
//   npm run review:cli -- <pr-url> "<task title>" "<task description>" [work-dir]
//
// Prints progress events, then the extracted result as JSON. The raw stream is saved to
// <work-dir>/stream.jsonl (default work dir: a fresh folder under the OS temp dir).
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSkill, resolveReviewEnvironment } from '../src/main/environment'
import { runReview } from '../src/main/reviewRunner'
import { parsePrUrl, validateReviewInput } from '../src/shared/validate'

async function main(): Promise<void> {
  const [prUrl, title, description, workDirArg] = process.argv.slice(2)
  const input = { prUrl: prUrl ?? '', title: title ?? '', description: description ?? '' }
  const errors = validateReviewInput(input)
  if (Object.keys(errors).length > 0) {
    console.error('Usage: review-cli <pr-url> "<title>" "<description>" [work-dir]')
    console.error(errors)
    process.exit(2)
  }
  input.prUrl = parsePrUrl(input.prUrl)!.url

  const workDir = workDirArg ?? (await mkdtemp(join(tmpdir(), 'pr-hub-')))
  await mkdir(workDir, { recursive: true })
  const [env, skill] = await Promise.all([resolveReviewEnvironment(), loadSkill()])
  console.error(`claude: ${env.claudePath}\nskill:  ${skill.skillDir}\nwork:   ${workDir}\n`)

  const started = Date.now()
  const handle = runReview({
    input,
    workDir,
    claudePath: env.claudePath,
    env: env.env,
    skill,
    model: process.env.PR_HUB_MODEL || undefined,
    emit: (event) => {
      const t = `${Math.round((Date.now() - started) / 1000)}s`.padStart(5)
      if (event.type === 'status') console.error(`${t}  · ${event.message}`)
      else if (event.type === 'tool') console.error(`${t}  → ${event.label}`)
      else if (event.type === 'error') console.error(`${t}  ✗ ${event.message}`)
      else if (event.type === 'cancelled') console.error(`${t}  ✗ cancelled`)
      else if (event.type === 'done') console.log(JSON.stringify(event.result, null, 2))
    }
  })
  process.on('SIGINT', () => handle.cancel())
  await handle.finished
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
