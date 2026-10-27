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
claude -p "<built prompt>" \
  --output-format stream-json --verbose \
  --permission-mode default \
  --allowedTools "Bash(bash:*) Bash(git:*) Bash(gh:*) Read Grep Glob" \
  --add-dir <work-dir>
```

- `cwd` = a fresh temp work dir per review (`userData/reviews/<id>/`).
- The prompt explicitly invokes the skill: "Use the pr-review skill to review <PR URL>. Task title: … Task description: …", then adds the JSON output contract.
- PR title, description and code are untrusted data. The skill already says this, and the prompt repeats it.
- Cancel = kill the child process. Timeout of 15 minutes by default.

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
