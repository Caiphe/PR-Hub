# PR Hub: Plan

A small desktop window (not full screen) where you enter a **task title**, a **PR link** and a **task description**. It runs the `pr-review` Claude skill in the background and shows the review: a verdict, a requirement checklist, and findings with suggested fixes. You can optionally post those findings to GitHub as review comments.

## Decisions

| Area                | Choice                                                                                               | Why                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell               | **Electron** (main + preload + renderer)                                                             | The core job is starting a CLI process and streaming its output. Node's `child_process` handles that with no extra language. Compact, always-on-top windows are easy to set up. |
| Language            | **TypeScript** everywhere                                                                            | One language for main and UI. The typed IPC contract keeps the two sides in sync.                                                                                               |
| UI                  | **React + Vite** (via `electron-vite`)                                                               | Fast dev loop and a simple component model for a 3-field form plus a results view.                                                                                              |
| Styling             | Plain CSS modules with tokens, light/dark through `prefers-color-scheme`                             | No framework is needed for one small window.                                                                                                                                    |
| Markdown            | `react-markdown` + `remark-gfm` + `rehype-highlight`                                                 | The skill outputs GFM tables and code blocks.                                                                                                                                   |
| Review engine       | **Headless Claude Code CLI**: `claude -p --output-format stream-json`                                | It uses the installed `pr-review` skill as is, so its logic isn't reimplemented. Stream-json gives live progress.                                                               |
| Structured findings | The prompt asks for a final ` ```json ` block with `{verdict, findings[]}` after the markdown review | The UI gets real data for cards, filters and GitHub posting, and the markdown is still there to read.                                                                           |
| GitHub              | `gh` CLI (fetching is the skill's job; posting is the app's job)                                     | It reuses the user's auth and avoids handling tokens in the app.                                                                                                                |
| Storage             | JSON file in `app.getPath('userData')` holding review history                                        | Boring and enough for this. No DB.                                                                                                                                              |
| Tests               | Vitest for pure logic (prompt builder, stream parser, JSON extractor)                                | Test the parts that can break silently.                                                                                                                                         |
| Packaging           | `electron-builder` → macOS `.dmg`                                                                    |                                                                                                                                                                                 |

Alternative considered: **Tauri** (smaller binary). It would add Rust for the process-spawning core, which is the most important part. The plan can switch later because the UI is plain React.

## Window

- 440×680, resizable, min 380×520, remembers its position.
- "Pin on top" toggle; a menu-bar (tray) icon shows or hides the window.
- Two views in the same window: **Form** → **Review** (back arrow returns to the form; history list on the form).

## Architecture

```
Renderer (React)                Preload                 Main (Node)
─────────────────               ────────                ────────────────────────
ReviewForm  ──startReview()──▶  contextBridge  ──IPC──▶ ReviewRunner
ReviewView  ◀──onEvent()─────                  ◀─IPC──   spawn('claude', [...])
History                                                   parse stream-json lines
                                                          extract final JSON
                                                         GitHubPoster (gh api)
                                                         HistoryStore (json file)
```

### How the review is run

```
echo "<built prompt>" | claude -p \
  --output-format stream-json --verbose \
  --append-system-prompt "<SKILL.md with <skill-dir> filled in>" \
  --tools "Read Grep Glob Bash" \
  --permission-mode dontAsk \
  --strict-mcp-config --no-session-persistence \
  --allowedTools Read Grep Glob "Bash(bash <skill-dir>/scripts/fetch_pr.sh:*)" \
                 "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)" "Bash(git blame:*)" \
                 "Bash(gh pr view:*)" "Bash(gh pr diff:*)"
```

As built in Prompt 3 (`src/main/reviewRunner.ts`); these choices differ from the first draft:

- **Skill loading:** headless `claude -p` does not load claude.ai-synced skills, so the app finds `pr-review/SKILL.md` under `~/.claude/skills` (or `PR_HUB_SKILL_DIR`) and passes it as an appended system prompt. The skill's own script does the fetching.
- **Permissions:** `--allowedTools` only _adds_ to the user's global permissions, so it can't restrict anything by itself. `--tools` limits which tools exist, and `dontAsk` denies anything not on the allowlist. Denials come back in the result event and are shown as `deniedTools`.
- **Prompt over stdin:** keeps the task text out of `ps` and avoids clashing with the variadic `--allowedTools`.
- **Environment:** PATH comes from the user's login shell (GUI apps get a minimal one). Nested-session variables (`CLAUDECODE`, `ELECTRON_RUN_AS_NODE`...) are stripped.
- `cwd` = a fresh work dir per review (`userData/reviews/<id>/`). The PR is fetched into `<id>/pr/` and the raw stream is saved to `<id>/stream.jsonl`.
- PR title, description and code are untrusted data. The skill already says this, and the prompt repeats it.
- Cancel = kill the child's process group (claude + bash/git children). Timeout of 15 minutes by default.
- `PR_HUB_MODEL` overrides the model. `npm run review:cli -- <url> "<title>" "<desc>"` runs the same runner without Electron.

### Posting to GitHub (Prompt 6, `src/main/github*.ts`)

- Two steps. `github:preview` builds the exact payload, caches it, and returns it for display. `github:post` submits only a cached preview, once. The renderer never sends a payload.
- One `POST /repos/{o}/{r}/pulls/{n}/reviews` via `gh api`, with `event` set to `COMMENT` or `REQUEST_CHANGES`.
- Inline comments only go on lines that are in the PR diff, computed from the `/files` patches. GitHub rejects the whole review otherwise. Other findings go in the review body, and the dialog says why for each one.
- Comments are anchored to the head commit the review saw (recorded in history as `headSha`). If the PR has new commits since, every finding goes in the body.
- ` ```suggestion ` is used only for one-line code. Multi-line fixes go in plain code blocks, because GitHub would replace just one line. Text that looks like prose is never posted as a suggestion (the prompt also forbids it).
- `@mentions` outside code are neutralized, since review text is partly derived from untrusted PR content.
- Successful posts are recorded on the history entry (`posted`), and those findings show a "Posted" badge.
- `PR_HUB_GH` points at a different `gh` binary. The stand-in used for testing serves fixtures and saves POST bodies instead of sending them.

### IPC contract (`src/shared/ipc.ts`)

- `review:start(input: {title, prUrl, description}) → {reviewId}`
- `review:cancel(reviewId)`
- `review:event` (main → renderer): `{reviewId, type: 'status'|'tool'|'text'|'done'|'error', payload}`
- `history:list() / history:get(id)`
- `github:postReview(reviewId, selectedFindingIds, mode: 'comment'|'request_changes')`

### Findings JSON contract

```json
{
  "verdict": "approve" | "approve_with_suggestions" | "request_changes",
  "summary": "string",
  "requirements": [{ "text": "", "status": "done|partial|missing", "notes": "" }],
  "findings": [{
    "id": "f1", "severity": "blocking|should_fix|nit",
    "title": "", "file": "path", "line": 42,
    "body": "", "suggestion": "optional code"
  }]
}
```

## Build phases

1. **Scaffold**: electron-vite + React + TS, compact window, lint/format, Vitest.
2. **Form UI**: 3 fields, validation (GitHub PR URL regex), submit and disabled states.
3. **Review runner (main)**: spawn `claude`, parse stream-json, emit IPC events, cancel/timeout, check that the CLI is present.
4. **Review view**: live progress (status + tool steps), then rendered markdown, then findings cards from JSON.
5. **History**: persist each review and reopen past ones.
6. **GitHub posting**: choose findings → `gh api` creates a PR review with inline comments (only on a button click, after confirmation).
7. **Polish & package**: tray, pin-on-top, dark mode, error states, `.dmg`.

## Risks and open points

- **`gh` isn't logged in** on this machine right now. Private repos and posting both need `gh auth login`. Public PRs work without it through the skill's git fallback.
- Reviews take minutes, so progress streaming is a must, not a nice-to-have.
- The model might not emit valid JSON. The extractor falls back to markdown-only view and never crashes.
- Headless permissions: if a tool the skill needs isn't allowed, the run stalls. Phase 3 logs denied tools so the allowlist can be tuned.
- Cost: every review is a full Claude Code session. Show the elapsed time and the `total_cost_usd` from the result event.
