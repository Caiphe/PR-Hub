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

### Incremental re-reviews (`src/shared/incremental.ts`, `src/main/incremental.ts`)

A PR reviewed before can be reviewed again for only what changed since, compared finding by finding with that review (its "parent").

- **Offering it (read-only).** `review:incremental-offer` picks the newest finished review of the PR from history, reads the PR's current head, and asks GitHub's compare API (gh, or the anonymous public API) how the parent's commit relates to it. Only `ahead` is offered. Every other answer is a reason shown in the form: no saved commit, no structured findings, no new commits, force-pushed or rebased (`diverged`/`behind`), or the check failed.
- **Data available.** The skill's fetch script makes a full-history, blob-less clone of the PR head and the base branch. The parent's commit is in it only if it's still an ancestor of the head. After a force-push it usually isn't fetchable at all.
- **Checked again after the fetch.** `prepareIncremental` runs `git` itself (argument arrays, validated 40-hex SHAs, `core.quotePath=false`): `rev-parse pr`, `cat-file -e <prev>^{commit}`, `merge-base --is-ancestor <prev> pr`. If any check fails, the run continues as a full review with the reason saved (`fallbackReason`); there's no second fetch and no question asked.
- **What the reviewer gets.** `pr/incremental.diff` (`git diff -M <prev> pr`, limited to files the PR touched at either commit plus files of previous findings, so a merge of `main` into the branch doesn't drown the change), `pr/incremental-commits.txt`, and the previous findings in a `<previous-findings>` block marked as data quoting untrusted content. It still has `pr.diff` and the full checkout, and is told to judge new commits in the whole PR's context. It lists every issue at the new head (`previous_id` links one to the previous finding it continues) and classifies each previous finding in `previous_findings`. The full-review prompt is unchanged (snapshot-tested).
- **Matching** (`compareFindings`, pure). Deterministic evidence: old lines mapped to new ones through `git diff -M -U0 <prev> pr` (renames, insertions, deletions), whether the old line was edited, and word-overlap similarity of title and body. The model's claim is accepted only when the evidence agrees:
  - linked and similar (or the line is untouched) → Still present;
  - "resolved" and the line or file changed or was deleted → Resolved (not tied to a line: the model's word is taken, and said so);
  - "resolved" but the code is untouched, a link that contradicts the evidence, a missing or malformed classification, or an unlinked near-duplicate → Unable to verify (an unlinked near-duplicate also gets a suggested match);
  - unlinked with no match → New.
- **Overrides.** Uncertain items can be settled locally (`history:set-override`): a previous finding as Still present or Resolved, a possible repeat as New or Still present. Settling one side of a suggested pair settles the other. Never sent to GitHub.
- **History (file version 3).** `incremental: {parentId, comparedSha, comparison}`, `fallbackReason`, `overrides`, all optional. Older entries read as full reviews. An incremental review's findings are the PR's current issues, so a chain of incremental reviews stays consistent.
- **Posting.** The same exact preview and confirmation. Only New findings are ticked by default; Still present and uncertain ones can be ticked explicitly. Resolved findings aren't findings of the review, so they can't be posted. Posted ids follow the lineage (`postedLineage`), so a still-present finding whose earlier version was posted is badged "Posted earlier", and the preview warns before posting it again.

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

- `review:start(input, {incrementalFrom?}) → {ok, reviewId} | {ok:false, error}`. `input.taskSource` (`manual`/`pr`/`issue`) marks PR- or issue-derived task text as untrusted in the prompt. `incrementalFrom` is a history id; main loads that review itself and only uses it if it's a finished review of the same PR with a commit and findings.
- `review:incremental-offer(prUrl, parentId?) → IncrementalOffer`: read-only, see "Incremental re-reviews".
- `review:cancel(reviewId)`
- `review:event` (main → renderer): `{reviewId, type: 'status'|'tool'|'text'|'done'|'error'|'cancelled', …}`. `done` carries `headSha` (the reviewed commit) when known, used for "Open on GitHub" links, and `incremental` (the comparison, or the fallback reason) when an incremental review was asked for.
- `history:list() → HistorySummary[]` · `history:get(id) → HistoryEntry | null` · `history:set-pinned(id, pinned)` · `history:delete(id)` (native confirmation in main) · `history:export(id, format)` (native save panel in main) · `history:set-override(id, key, value | null)` (uncertain comparison items only)
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
    "body": "", "suggestion": "optional code",
    "previous_id": "incremental reviews only: the previous finding this continues, or null"
  }],
  "previous_findings": [{ "id": "", "status": "still_present|resolved|unable_to_verify", "evidence": "" }]
}
```

`previous_id` and `previous_findings` are asked for only in incremental reviews. A malformed `previous_findings` list is dropped rather than failing the block; every previous finding then shows as Unable to verify.

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
