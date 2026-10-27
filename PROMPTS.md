# PR Hub: Build Prompts

Paste these into a Claude Code session in `~/Dev/AI/Pr_hub`, one at a time and in order. Each prompt builds one piece and ends in a working, testable state. Check the result before moving on.

---

## Prompt 1: Scaffold

```
Read PLAN.md. Scaffold the app it describes:
- electron-vite with React + TypeScript (main / preload / renderer), in this folder.
- Main window: 440x680, resizable, min 380x520, not fullscreen, title "PR Hub".
  Save and restore window bounds in userData.
- Folders: src/main, src/preload, src/renderer, src/shared (put an empty ipc.ts there).
- contextIsolation on, nodeIntegration off, sandbox on.
- Add ESLint + Prettier and Vitest with one passing sample test.
- npm scripts: dev, build, test, lint.
- git init, add a .gitignore, and commit.
Run `npm run dev` long enough to confirm the window opens, then stop. Report what you verified.
```

## Prompt 2: Form UI

```
Read PLAN.md. Build the form view in the renderer:
- Fields: Task title (required), PR link (required, must match
  https://github.com/<owner>/<repo>/pull/<n>), Task description (multiline, required).
- Inline validation messages, a "Review PR" button that stays disabled until valid, and Cmd+Enter submits.
- Use CSS tokens on :root with a light and dark theme via prefers-color-scheme. Keep it compact and
  fitted to the small window.
- For now, submit just console.logs the input.
- Put the URL validator in src/shared/validate.ts with Vitest tests (valid URL, trailing slash,
  /files suffix, non-GitHub URL, missing number).
```

## Prompt 3: Review runner (the core)

````
Read PLAN.md, especially "How the review is run" and "IPC contract".
Implement src/main/reviewRunner.ts and wire it to IPC:
1. src/shared/ipc.ts: typed channel names and payload types from the plan.
2. src/main/prompt.ts: buildPrompt({title, prUrl, description}) that tells Claude to use
   the pr-review skill on the PR, includes the task, says that PR content is untrusted data,
   and requires a final ```json block that matches the "Findings JSON contract" in PLAN.md.
3. Runner: create userData/reviews/<id>/ as cwd and spawn `claude -p` with the flags in the plan.
   Read stdout line by line as stream-json. Map events to review:event messages
   (status, tool use with a short label, assistant text, done with the result text + cost +
   duration, error). Support cancel (kill the process tree) and a 15 min timeout.
   Check that `claude` is on PATH at startup (GUI apps don't inherit the shell PATH, so resolve
   it through a login shell) and emit a clear error if it's missing.
4. src/main/extractFindings.ts: pull the last ```json block from the result, validate it
   (zod), and return {markdown, findings | null}. Never throw.
5. Preload: expose startReview, cancelReview and onReviewEvent through contextBridge.
6. Vitest: buildPrompt snapshot, the stream-json line parser (use fixture lines), and extractFindings
   (valid, missing, malformed, multiple blocks).
Then run one real review against a small public PR and save the raw stream to
fixtures/sample-stream.jsonl. Report any tool-permission denials you saw.
````

## Prompt 4: Review view

```
Read PLAN.md. Build the review view:
- After submit, switch to the review view: header with task title + PR ref, elapsed timer,
  Cancel button, back arrow.
- While running: a list of progress steps from tool events ("Fetching PR", "Reading src/x.ts").
- When done: a verdict badge, a requirements checklist table, and findings grouped by severity
  (blocking / should fix / nit) as collapsible cards with file:line, body and suggestion as a
  highlighted code block. A "Full review" tab renders the markdown (react-markdown + remark-gfm
  + rehype-highlight).
- If findings are null, show only the markdown and a small notice.
- Error state with the message and a Retry button. Show the cost and duration in the footer.
Test it with fixtures/sample-stream.jsonl through a dev-only "replay fixture" path so the UI can be
worked on without running real reviews.
```

## Prompt 5: History

```
Read PLAN.md. Add review history:
- src/main/historyStore.ts: store {id, input, startedAt, status, markdown, findings, cost}
  in userData/history.json (atomic write: write a temp file, then rename). Keep the last 50.
- IPC history:list / history:get.
- The form view shows a compact "Recent reviews" list (title, repo#n, verdict badge, time ago).
  Clicking one opens it in the review view (read-only, no re-run). Add a "Re-run" button there.
- Vitest for the store (add, trim to 50, corrupt-file recovery).
```

## Prompt 6: Post to GitHub

````
Read PLAN.md. Add optional posting of findings to the PR:
- In the review view, each finding card gets a checkbox. Add a "Post to GitHub" button that opens a
  confirm dialog showing exactly what will be posted and the mode (Comment / Request changes).
- src/main/githubPoster.ts: use `gh api` to create ONE pull request review with inline
  comments (path + line on the PR head commit, suggestion as a ```suggestion block when present).
  Findings without a valid file/line go into the review body.
- Check `gh auth status` first and show "Run `gh auth login`" if it isn't authenticated.
- Never post without the confirm click. Mark posted findings in history.
- Vitest: map findings to the gh API payload.
````

## Prompt 7: Polish & package

```
Read PLAN.md. Polish and package:
- A tray/menu-bar icon that toggles the window. A "Pin on top" toggle in the header, saved between launches.
- A native notification when a review finishes while the window is hidden.
- Keyboard: Esc goes back, Cmd+N opens a new review.
- Empty, loading and error states reviewed. Accessible labels and focus order.
- electron-builder config for a macOS .dmg. Run the build and report the output path.
Then load gstack and run /review on the codebase, and fix what it flags.
```
