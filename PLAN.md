# PR Hub: Plan

A small desktop window (not full screen) where you enter a **task title**, a **PR link** and a **task description**. It runs the `pr-review` Claude skill in the background and shows the review: a verdict, a requirement checklist, and findings with suggested fixes. You can optionally post those findings to GitHub as review comments.

## Decisions

| Area                | Choice                                                                                                           | Why                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell               | **Electron** (main + preload + renderer)                                                                         | The core job is starting a CLI process and streaming its output. Node's `child_process` handles that with no extra language. Compact, always-on-top windows are easy to set up. |
| Language            | **TypeScript** everywhere                                                                                        | One language for main and UI. The typed IPC contract keeps the two sides in sync.                                                                                               |
| UI                  | **React + Vite** (via `electron-vite`)                                                                           | Fast dev loop and a simple component model for a 3-field form plus a results view.                                                                                              |
| Styling             | One global stylesheet (`assets/main.css`) with CSS custom-property tokens, light/dark via `prefers-color-scheme` | No framework is needed for one small window.                                                                                                                                    |
| Markdown            | `react-markdown` + `remark-gfm` + `rehype-highlight`                                                             | The skill outputs GFM tables and code blocks.                                                                                                                                   |
| Review engine       | **Headless Claude Code CLI**: `claude -p --output-format stream-json`                                            | It uses the installed `pr-review` skill as is, so its logic isn't reimplemented. Stream-json gives live progress.                                                               |
| Structured findings | The prompt asks for a final ` ```json ` block with `{verdict, findings[]}` after the markdown review             | The UI gets real data for cards, filters and GitHub posting, and the markdown is still there to read.                                                                           |
| GitHub              | `gh` CLI (fetching is the skill's job; posting is the app's job)                                                 | It reuses the user's auth and avoids handling tokens in the app.                                                                                                                |
| Storage             | JSON file in `app.getPath('userData')` holding review history                                                    | Boring and enough for this. No DB.                                                                                                                                              |
| Tests               | Vitest for pure logic (prompt builder, stream parser, JSON extractor)                                            | Test the parts that can break silently.                                                                                                                                         |
| Packaging           | `electron-builder` → macOS `.dmg`                                                                                |                                                                                                                                                                                 |

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
bash <skill-dir>/scripts/fetch_pr.sh <validated PR URL> "<work-dir>/pr"   # run by the app
echo "<built prompt>" | claude -p \
  --output-format stream-json --verbose \
  --append-system-prompt "<SKILL.md with <skill-dir> filled in>" \
  --tools "Read Grep Glob Bash" \
  --permission-mode dontAsk \
  --strict-mcp-config --no-session-persistence
```

As built (`src/main/reviewRunner.ts`). Prompt 3 set this up, and the Prompt 7 `/review` hardened it:

- **Skill loading:** headless `claude -p` does not load claude.ai-synced skills, so the app finds `pr-review/SKILL.md` under `~/.claude/skills` (or `PR_HUB_SKILL_DIR`) and passes it as an appended system prompt.
- **The app fetches the PR, not the model.** The app runs the skill's fetch script with a validated URL and a fixed destination, passing arguments as an array (paths with spaces work). The model gets the fetch log and is told step 1 is done. A failed fetch ends the review before any model cost.
- **No allow rules at all.** `--tools` limits which tools exist. `dontAsk` denies anything that would need approval. In this mode Read/Grep/Glob only work inside the cwd (the work dir), and an explicit `Read` allow rule would extend that to the whole disk (verified by probing). Model-chosen `git`/script arguments were dropped because `git log/diff/show --output=<file>` writes files. Any denials come back as `deniedTools`.
- **Prompt over stdin:** keeps the task text out of `ps`.
- **Environment:** PATH comes from the user's login shell (GUI apps get a minimal one). Nested-session variables (`CLAUDECODE`, `ELECTRON_RUN_AS_NODE`...) are stripped.
- `cwd` = a fresh work dir per review (`userData/reviews/<id>/`), with the PR in `<id>/pr/` and the raw stream in `<id>/stream.jsonl`.
- PR title, description, code and commit messages are untrusted data. The skill says so and the prompt repeats it.
- Cancel and timeout (15 minutes by default, 5 to 60 in Settings) cover both the fetch and the review, and kill each child's whole process group. Quitting the app stops running reviews first.
- `PR_HUB_MODEL` overrides the model. `npm run review:cli -- <url> "<title>" "<desc>"` runs the same runner without Electron.

### Posting to GitHub (Prompt 6, `src/main/github*.ts`)

- Two steps. `github:preview` builds the exact payload, caches it, and returns it for display. `github:post` submits only a cached preview. The renderer never sends a payload, and anything besides the preview id and the `force` flag is ignored.
- Each preview is one submission: `ready → submitting → posted`, or `uncertain` when the outcome is unclear. Its random id goes in the body as `<!-- pr-hub-submission:<uuid> -->`, the only raw HTML PR Hub sends. Failures are classified (`postFailureKind`) as retryable, needs_auth or needs_new_preview (nothing accepted; the first two can resend the same preview), or ambiguous (timeout, dropped connection, 5xx, unknown). After an ambiguous failure PR Hub never retries by itself. It lists the PR's reviews for the marker: if found, it records the post; if not, the user decides. A later `post` on an uncertain submission looks again before sending, and `force` (an explicit "Post anyway") skips that only when the check itself fails. A posted submission answers repeat posts with its record.
- One `POST /repos/{o}/{r}/pulls/{n}/reviews` via `gh api`, with `event` set to `COMMENT` or `REQUEST_CHANGES`.
- Inline comments only go on lines that are in the PR diff, computed from the `/files` patches. GitHub rejects the whole review otherwise. Other findings go in the review body, and the dialog says why for each one.
- Comments are anchored to the PR's current head. The line numbers come from the commit the review saw (`headSha` in history). If the head moved, `compare/<reviewed>...<head>` lists the files that changed: findings in other files keep their lines, and findings in changed files go in the body, marked `movedByChange`. If that list is unknown (force-push, 300+ files) or the reviewed commit wasn't recorded, every finding goes in the body.
- Request changes on the user's own PR is refused before sending (`ownPr` from the PR author).
- ` ```suggestion ` is used only for one-line code. Multi-line fixes go in plain code blocks, because GitHub would replace just one line. Text that looks like prose is never posted as a suggestion (the prompt also forbids it).
- Outside code, `@mentions` are neutralized and `<` is escaped (no raw HTML such as hidden `<!-- -->` comments), since review text is partly derived from untrusted PR content.
- Once GitHub accepts a post it counts as posted, even if recording it locally fails. Records carry the submission id, so a recovered or repeated confirmation is stored once (`addPostRecord`, and the renderer reducer).
- Successful posts are recorded on the history entry (`posted`), and those findings show a "Posted" badge.
- `PR_HUB_GH` points at a different `gh` binary. The stand-in used for testing serves fixtures and saves POST bodies instead of sending them.

### IPC contract (`src/shared/ipc.ts` is the source of truth)

Every handler checks that the call comes from the app's own page (`src/main/ipcGuard.ts`), and the window can't navigate away from it.

- `review:start(input) → {ok, reviewId} | {ok:false, error}`. `input.taskSource` (`manual`/`pr`/`issue`) marks PR- or issue-derived task text as untrusted in the prompt.
- `review:cancel(reviewId)`
- `review:event` (main → renderer): `{reviewId, type: 'status'|'tool'|'text'|'done'|'error'|'cancelled', …}`. `done` carries `headSha` (the reviewed commit) when known, used for "Open on GitHub" links.
- `history:list() → HistorySummary[]` · `history:get(id) → HistoryEntry | null` · `history:set-pinned(id, pinned)` · `history:delete(id)` (native confirmation in main) · `history:export(id, format)` (native save panel in main)
- `github:preview(reviewId, findingIds, mode) → PostPreview` · `github:post(previewId, {force?}) → PostRecord | failure` · `github:verify-post(previewId)`: a read-only marker lookup for an unclear submission
- `github:inspect-pr(prUrl) → PrMetadata` · `github:inspect-issue(issueUrl) → IssueDetails`: read-only intake metadata (`src/main/prInspect.ts`). They use gh when it's signed in and the anonymous public API otherwise, re-validate the link in main, cache answers for 2 minutes, and return a fixed subset of cleaned, size-capped text.
- `github:status(prUrl?) → ConnectionStatus`: read-only gh check (`--version`, `auth status`, one GET of the PR). Never writes, never returns a token. Preview/post failures carry a classified `problem` with fix-it steps (`src/main/githubErrors.ts`).
- `settings:get` · `settings:set-always-on-top` · `settings:update(change)` (validated in main; bad values ignored) · `settings:restore-defaults` · `settings:browsers` · `settings:changed` (main → renderer) · `app:open-settings` (main → renderer)
- `app:new-review` (main → renderer, from the menu-bar menu)
- `dev:replay-fixture(variant)` (development builds only)

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

- **`gh` isn't logged in** on this machine right now. Private repos and posting both need `gh auth login`. Public PRs work without it through the fetch script's git fallback.
- Reviews take minutes, so progress streaming is a must, not a nice-to-have.
- The model might not emit valid JSON. The extractor falls back to markdown-only view and never crashes.
- Headless permissions: anything outside the work dir is denied. Denials are shown in the footer ("N tool call(s) blocked") so the policy can be revisited if reviews need more.
- Cost: every review is a full Claude Code session. Show the elapsed time and the `total_cost_usd` from the result event.
