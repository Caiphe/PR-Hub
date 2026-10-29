# PR Hub

PR Hub is a small macOS window that reviews a GitHub pull request against the task it was meant to do. You give it a task title, a PR link and a description. It runs the [`pr-review`](#requirements) Claude Code skill in the background and shows:

- a verdict: Approve, Approve with suggestions, or Request changes;
- a checklist of the task's requirements, each marked done, partial or missing;
- findings grouped by severity, each with its file and line and a suggested fix.

You can then post the findings you choose to the PR as a GitHub review. Nothing is posted until you've seen exactly what will be sent and confirmed it.

![PR Hub icon](build/icon.png)

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Using PR Hub](#using-pr-hub)
- [How a review works](#how-a-review-works)
- [Security model](#security-model)
- [Where data is stored](#where-data-is-stored)
- [Development](#development)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Requirements

| Requirement                                                       | Why                                                                                                                                                                                                     | Check                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| macOS on Apple Silicon                                            | The packaged build is arm64. Other platforms are untested (see [Limitations](#limitations)).                                                                                                            |                                             |
| [Claude Code](https://docs.claude.com/claude-code) CLI, signed in | Runs the review                                                                                                                                                                                         | `claude --version`                          |
| The `pr-review` skill                                             | Its instructions and its `scripts/fetch_pr.sh` drive the review. PR Hub looks for a `pr-review` folder containing `SKILL.md` anywhere under `~/.claude/skills`, including skills synced from claude.ai. | `ls ~/.claude/skills/**/pr-review/SKILL.md` |
| `git` and `python3`                                               | Used by the skill's fetch script                                                                                                                                                                        | `git --version`                             |
| [GitHub CLI](https://cli.github.com) (`gh`), signed in            | Needed only for **private repos** and **posting to GitHub**. Public PRs can be reviewed without it.                                                                                                     | `gh auth status`                            |

Each review is a full Claude Code session and is billed to your Claude account. Small PRs have cost about $0.10–$0.50 in testing. The app shows the cost of every review.

## Install

### From the DMG

1. Build it (see [Packaging](#packaging)) or get `pr-hub-<version>-arm64.dmg` from whoever built it.
2. Open the DMG and drag **PR Hub** to Applications.
3. The first time you open it, macOS may say it can't verify the developer, because the build is only ad-hoc signed. Right-click the app and choose **Open**, then **Open** again.
4. Optional: run `gh auth login` in a terminal to enable private repos and posting.

### From source

```bash
git clone <this repo> pr-hub && cd pr-hub
npm install
npm run dev
```

## Using PR Hub

### Review a PR

1. Paste the **PR link** (`https://github.com/<owner>/<repo>/pull/<n>`; `/files`, `?query` and `#anchors` are fine). A moment after you stop typing, PR Hub looks the PR up and shows a summary: `owner/repo#n`, author, draft or merged state, `base ← head` (with the fork owner for PRs from forks), files changed and lines added/removed. It warns about drafts, closed PRs and very large PRs (50+ files or 2,000+ changed lines), but never blocks them.
2. Choose where the task comes from under **Task from**:
   - **Linked issue**: an issue the PR body closes ("Fixes #12", "closes owner/repo#3") or links to. Its title and body are fetched only when you pick it.
   - **PR title and description**, which is filled in automatically.
   - **Write my own**: paste the ticket and acceptance criteria yourself.
3. Check and edit the **Task title** and **Task description**. The review is graded against this text, so a PR's own description is weaker evidence than the real ticket.
4. Click **Review PR**, or press **⌘ Enter**.
5. Watch the progress list ("Fetching the PR", "Reading src/…"). Reviews usually take one to four minutes. You can hide the window; if it's hidden when the review finishes, you get a notification.
6. When it's done, there are two tabs:
   - **Findings:** the verdict with counts per severity, the requirement checklist, and the findings workspace (below).
   - **Full review:** the complete written review.

How the task is filled in:

- **Your text is never overwritten silently.** Auto-filling only touches empty fields and text PR Hub filled in itself that you haven't changed. If you pick another source after editing, PR Hub asks first: **Replace** or **Keep mine**. Switching to **Write my own** clears only untouched auto-filled text.
- If you change the link to a PR that can't be looked up, untouched text from the previous PR is cleared, because it describes a different change.
- **Lookups are read-only** and cached for two minutes. PR Hub uses your `gh` login when there is one (so private repos work), and otherwise GitHub's public API without credentials, so public PRs need no login. Without a login, GitHub allows about 60 lookups an hour.
- **PR and issue text is untrusted.** It is shown as plain text, never rendered as HTML, and cleaned of control characters. When the task came from the PR or an issue, the review prompt says so and tells the reviewer not to follow instructions in it.
- If the lookup fails, the summary says why, and you can fill in the task yourself as before.

The footer shows how long the review took and what it cost. If the reviewer tried something it isn't allowed to do, the footer also says how many tool calls were blocked; hover over it for details.

### Findings workspace

- **Severity chips** in the summary (Blocking, Should fix, Nits) show the counts. Click one or more to show only those severities.
- **Search** matches finding titles, text, file paths and suggested changes. Every word must match. **Esc** clears the search; a second **Esc** goes back to the form.
- **View** opens grouping and filters. **Group by** Severity or File (file groups list files alphabetically, then findings not tied to a file). The choice is remembered until you quit the app. **Selection** (selected / not selected for posting) and **Posting** (posted / not posted) narrow the list further.
- Filters combine: a finding is shown only if it matches all of them. The count line says "Showing N of M". When nothing matches, PR Hub lists the active filters and offers **Clear filters**.
- **Filters never change the selection.** Hidden findings stay ticked or unticked, and the post bar says how many selected findings are hidden.
- **Expand all** / **Collapse all** act on the findings currently shown.
- **↑ / ↓**, or **K / J**, move to the previous or next finding in display order, open it, and focus it.
- **Open on GitHub** (inside an expanded finding) opens the file at that line in the exact commit that was reviewed, in your browser. It appears only when the finding has a file and a line and PR Hub knows the reviewed commit. The link is built from the validated PR link, the commit SHA and the encoded path, never from text in the review.

### Post findings to GitHub

1. Tick the findings to include. Blocking and should-fix findings are ticked by default; nits are opt-in.
2. Click **Post to GitHub…**.
3. The dialog shows exactly what will be posted:
   - the account, the base repository, and the commit the comments attach to (plus the reviewed commit, if the PR has moved on),
   - the review type, and how many findings go inline and how many in the summary,
   - any permission warning (for example, a fine-grained token that might not be allowed to post),
   - the review summary and each inline comment with its `file:line`,
   - which findings go in the summary instead of on a line, and why. Findings moved there because the PR changed are listed separately.
4. Choose **Comment** or **Request changes**, then click **Post**. On a PR you opened, **Request changes** is disabled (GitHub doesn't allow it), with a one-click switch to **Comment**.

Posted findings get a **Posted** badge, which is still there when you reopen the review later.

How findings are placed:

- **Inline comments only go on lines the PR changed.** GitHub rejects a review if any comment points elsewhere, so other findings go in the summary.
- **Line numbers are trusted only where the code hasn't changed.** If the PR has new commits since the review, PR Hub asks GitHub which files changed between the reviewed commit and the new head. Findings in unchanged files stay on their lines; findings in changed files move to the summary, and the dialog lists them. If PR Hub can't tell what changed (for example after a force-push), everything goes in the summary. Re-run the review to get inline comments on the new code.
- **One-line code fixes become one-click GitHub suggestions,** and the preview labels them. Longer fixes are posted as plain code blocks, because GitHub would apply them to a single line.

When posting fails, the preview stays on screen and the dialog says what happened:

| What happened                                                                     | What you can do                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GitHub refused before accepting anything (rate limit, no connection)              | **Try again** sends the same preview.                                                                  |
| A login or permission problem (401, 403, 404, SSO, organization approval)         | Fix it using the steps shown, then **Try again** with the same preview. No need to re-select anything. |
| GitHub rejected the content (422: the PR changed, Request changes on your own PR) | **Rebuild preview** (or **Switch to Comment**). The old preview can't be posted.                       |
| No clear answer (timeout, dropped connection, a GitHub 5xx)                       | See below.                                                                                             |

**No duplicate reviews.** Every preview gets a random submission id, and its summary ends with an invisible HTML comment holding only that id (`<!-- pr-hub-submission:… -->`). If GitHub doesn't confirm a post, PR Hub doesn't retry. It reads the PR's reviews looking for that id:

- **Found:** the review was posted after all. PR Hub shows it as posted and records it once.
- **Not found:** the dialog says it probably wasn't posted. **Post again** is a separate, explicit button, and it checks once more before sending.
- **The check fails too:** **Check GitHub again**, or **Post anyway** if you've looked at the PR yourself.

Until an unclear post is resolved, the review type can't be changed. A new preview for the same review warns that an earlier post may be on GitHub. Posting the same confirmed preview twice (a double click, for example) never creates a second review.

### History

The form lists your three most recent reviews with their verdict. Click one to reopen it read-only. **Re-run** reviews the PR again with the same task, and **←** returns to the form with that task filled in.

**All history** (under the recent list) opens the History view:

- **Search** by task title, `owner/repo`, PR number (`#12` or `owner/repo#12`) or the review summary. Every word must match.
- **Filters** narrow by verdict (including _No verdict_ for failed reviews and reviews without structured findings), status, posted or not, pinned, repository, and a date range. Dates are inclusive and in your local time. Filters combine, and the count shows how many reviews match. Search and filters are kept while the app runs, so opening a review and coming back doesn't lose them.
- **PR timelines**: repeat reviews of the same PR are grouped, newest first. Each run shows its date, reviewed commit, duration, cost, verdict, blocking / should-fix / nit counts and whether it was posted. Click a run to open it; **←** from there returns to History.
- **Pin** (the star) keeps a review past the history limit.
- **⋯** on a run offers **Export Markdown**, **Export JSON** and **Delete…**.

Esc clears the search, then goes back to the form.

#### Retention and pinning

The newest 50 unpinned reviews are kept by default (change it in **Settings → History**, 10 to 500); older ones are removed, with their folders, when a new review is saved. Pinned reviews are never removed by this and don't count towards the limit. Lowering the limit also takes effect at the next saved review. Unpinning doesn't remove anything straight away: the next saved review trims the list.

#### Export

Export writes one review to a file you pick in the standard save panel (Downloads is suggested). The panel asks before replacing an existing file. Exports contain what history holds for that review: the task, PR link and reviewed commit, verdict, summary, requirements, findings, the full written review, any error, and post records. They never contain the raw Claude event stream, PR Hub's internal submission ids, or blocked tool names, and anything token-like is replaced with `[redacted]`.

- **Markdown**: a readable report (`pr-hub-<owner>-<repo>-<number>-<date>.md`).
- **JSON**: structured data for scripts, in this shape (`version` changes only when a field changes meaning or is removed):

```jsonc
{
  "format": "pr-hub-review",
  "version": 1,
  "exportedAt": "2026-10-29T12:00:00.000Z", // ISO 8601, UTC
  "review": {
    "id": "…",
    "status": "done", // or "error"
    "startedAt": "…",
    "endedAt": "…", // ISO 8601, UTC
    "durationMs": 180000,
    "costUsd": 0.41, // null when unknown
    "pinned": false,
    "task": { "title": "…", "description": "…", "source": "manual" }, // source: manual | pr | issue | null (older reviews)
    "pullRequest": {
      "url": "…",
      "owner": "acme",
      "repo": "hooks",
      "number": 12,
      "reviewedCommit": "<40-char SHA> or null"
    },
    "verdict": "request_changes", // approve | approve_with_suggestions | request_changes | null
    "summary": "…", // null without structured findings
    "requirements": [{ "text": "…", "status": "partial", "notes": "…" }],
    "findings": [
      {
        "id": "f1",
        "severity": "blocking",
        "title": "…",
        "file": "src/a.ts",
        "line": 14,
        "body": "…",
        "suggestion": "…"
      }
    ],
    "findingsError": null, // why structured findings are missing, when they are
    "markdown": "…", // the full written review; null for a failed review
    "error": null, // the failure message for a failed review
    "posted": [{ "at": "…", "url": "…", "mode": "comment", "findingIds": ["f1"] }]
  }
}
```

#### Delete

**Delete…** asks for confirmation in a system dialog, then removes the review from `history.json` and deletes its `reviews/<id>/` folder. It only affects this Mac: reviews already posted to GitHub stay on GitHub.

### Settings

Open **Settings** with the sliders button in the form header, or **Settings…** in the menu-bar menu. It opens over whatever is showing, even a running review, and **←** or Esc returns there. Each change is checked and saved straight away.

| Setting                  | Choices                         | Default        | Notes                                                                                                                             |
| ------------------------ | ------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Open links in            | System default, Firefox, Chrome | System default | Your macOS default browser is never changed. See [Browser choice](#browser-choice).                                               |
| Default review type      | Comment, Request changes        | Comment        | Preselected in the post dialog. The preview and confirmation are unchanged, and Request changes is never offered on your own PR.  |
| Review timeout           | 5 to 60 minutes                 | 15             | A running review keeps the timeout it started with.                                                                               |
| Model                    | A model name, or blank          | Blank          | For example `sonnet`, `opus` or `claude-sonnet-5-5`. See [Configuration](#configuration) for how it combines with `PR_HUB_MODEL`. |
| Reviews kept             | 10 to 500                       | 50             | Pinned reviews are always kept and don't count.                                                                                   |
| Completion notifications | On, Off                         | On             | A notification when a review finishes while the window is hidden. Also in the menu-bar menu.                                      |
| Keep on top              | On, Off                         | Off            | Same as the pin button and the menu-bar menu.                                                                                     |

Timeout and model apply to the next review. **Restore defaults…** lists exactly what will change and asks before changing anything. It doesn't touch history or the window position.

There is deliberately no field for a program path or a command: PR Hub only ever runs `claude`, `gh`, `git` and macOS's `open`.

#### Browser choice

Links (PR links, **Open on GitHub**, posted reviews) open in the chosen browser through `open -b <bundle id>` (`org.mozilla.firefox`, `com.google.Chrome`), with the link passed as a single argument and no shell. Only `http` and `https` links without embedded credentials are opened. If the chosen browser can't be launched (not installed, removed), the link opens in your system browser instead, and Settings says so. Settings also warns when the browser isn't in `/Applications` or `~/Applications`.

Builds before Settings always opened links in Firefox. An upgraded install keeps Firefox; a new install starts with System default.

### Window and shortcuts

| Action                                                 | How                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Show or hide the window                                | Click the menu-bar icon                                |
| New review, Keep on Top, notifications, Settings, Quit | Right-click the menu-bar icon                          |
| Keep the window above others                           | Pin button in the header (remembered between launches) |
| Submit the form                                        | ⌘ Enter                                                |
| New review (clears the form)                           | ⌘ N                                                    |
| Back / close the post dialog                           | Esc                                                    |
| Switch Findings / Full review                          | ← → when a tab is focused                              |
| Next / previous finding                                | J / K (or the ↓ ↑ buttons)                             |
| Clear the findings search                              | Esc in the search box                                  |

Closing the window hides it; a running review keeps going. Quit from the menu-bar menu or with ⌘ Q, which stops any running review first.

## How a review works

````
Form ──IPC──▶ main process
               1. bash <skill>/scripts/fetch_pr.sh <validated URL> <work dir>/pr
               2. claude -p (stream-json) with the skill as system prompt
                    reads pr.diff, files.txt, commits.txt and the checkout in <work dir>
               3. parse events → progress in the window
               4. extract the final ```json findings block, validate it (zod)
               5. save to history, delete the PR checkout
Window ◀── review:event ──┘
````

- **The app fetches the PR itself,** using the skill's fetch script. It passes the validated PR URL and a fixed destination as an argument list (no shell), so paths with spaces are safe and the model never picks arguments. If the fetch fails (private repo without `gh auth login`, wrong link, no network), the review stops before any model cost.
- **Skill loading:** headless `claude -p` doesn't load claude.ai-synced skills. So the app reads `SKILL.md`, fills in its folder path, and passes it with `--append-system-prompt`.
- **Structured output:** the prompt asks the reviewer to end with a JSON block: verdict, summary, requirements, and findings with `id`, `severity`, `file`, `line`, `body` and `suggestion`. If that block is missing or invalid, the app shows the written review with a notice and never crashes.
- **Cancel and timeout:** both cover the fetch and the review, and kill each process group (`claude` plus anything it started). The timeout is 15 minutes by default (Settings, 5 to 60).

[PLAN.md](PLAN.md) has the full design, the IPC contract and the reasoning behind each choice. [PROMPTS.md](PROMPTS.md) has the step-by-step build prompts the app was developed from.

## Security model

The reviewer reads **untrusted input**: the PR's code, description and commit messages. The design assumes a PR may try to steer it.

**What the reviewer can do**

```
claude -p --tools "Read Grep Glob Bash" --permission-mode dontAsk   (no allow rules)
```

- `--tools` limits the reviewer to four tools. `dontAsk` refuses anything that would need approval, since nobody is there to answer.
- With no allow rules, file reads only work inside that review's own folder. An explicit `Read` rule would extend reads to the whole disk, which was verified.
- It can't edit files, run `git` or `gh`, use the network, or run the fetch script with its own arguments. (`git log/diff/show --output=<file>` can write files, which is why git isn't allowed.)
- The task text is sent over standard input, so it doesn't appear in process listings.

**What gets posted to GitHub**

- Two steps. The preview builds the exact payload and the main process keeps it. Post sends only that stored preview, once. The window never supplies the payload itself.
- Outside code, `@mentions` are disabled (so text from the PR can't ping people from your account), and `<` is escaped. That stops raw HTML, such as a hidden `<!-- … -->` comment, from carrying text the preview didn't show.
- A suggestion that reads like an instruction, not code, is never posted as a one-click suggestion.

**The app itself**

- The window runs sandboxed: `contextIsolation`, no Node access, `sandbox: true`. The preload exposes only the typed `window.api`.
- Every IPC handler checks that the call comes from the app's own page. The window can't navigate to another site (links open in your browser), and only one copy of the app runs at a time.
- GitHub access goes through your own `gh` login. PR Hub never sees or stores a token.

## Where data is stored

Everything lives in `~/Library/Application Support/PR Hub/`:

| Path                        | Contents                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `history.json`              | Finished reviews: the newest 50 unpinned plus every pinned one. Task, written review, findings, cost, reviewed commit, post records |
| `reviews/<id>/stream.jsonl` | The raw Claude Code event stream, for debugging. Deleted when the review drops out of history or is deleted. Never exported.        |
| `reviews/<id>/pr/`          | The PR checkout, only while a review is running. Deleted when it ends.                                                              |
| `settings.json`             | Settings (`version: 2`); invalid or unknown values become safe defaults when read                                                   |
| `window-state.json`         | Window size and position                                                                                                            |

To remove one review, use **Delete…** in History. To clear everything, quit the app and delete that folder.

`history.json` is versioned (`version: 2` since pinning; version 1 files are read as they are). Reading is tolerant: an entry this build can't parse, such as one written by a newer version, is hidden but kept in the file, and fields it doesn't know on readable entries are written back unchanged. If the whole file is unreadable it's moved aside as `history.json.corrupt-<time>` rather than overwritten. Writes go to a temporary file that's renamed into place, so a crash never leaves half a file.

## Development

```bash
npm install
npm run dev          # app with hot reload (renderer) and restart (main)
npm test             # unit tests (Vitest), ~230 tests
npm run test:watch
npm run lint
npm run typecheck
npm run build        # typecheck + production bundle in out/
npm run format       # prettier
```

### Working on the review screen without paying for reviews

In development builds the form has **Dev · replay fixture** links: _full_, _no findings_ and _error_. They replay [fixtures/sample-stream.jsonl](fixtures/sample-stream.jsonl), a real recorded review, through the same parser as a live run. Replays aren't saved to history and can't be posted. The links and the replay handler don't exist in packaged builds.

### Running a review from the terminal

```bash
npm run review:cli -- https://github.com/owner/repo/pull/123 "Task title" "Task description" [work-dir]
PR_HUB_MODEL=haiku npm run review:cli -- …   # cheaper, for testing
```

This uses the same runner as the app (no Electron). It prints progress to stderr and the result as JSON to stdout, and saves the raw stream to `<work-dir>/stream.jsonl`.

### Testing GitHub posting without posting

Point `PR_HUB_GH` at a stand-in script that answers `gh auth status` / `gh api …` from fixtures and saves POST bodies to a file instead of sending them. The real responses for one PR are in [fixtures/github/](fixtures/github/). Combine it with `PR_HUB_USER_DATA` so test data stays out of your real history:

```bash
PR_HUB_USER_DATA=/tmp/prhub-test PR_HUB_GH=/path/to/fake-gh npm run dev
```

### Icons

The app icon and menu-bar icon are drawn from SVG sources in [resources/icons/](resources/icons/). After editing them:

```bash
npm run icons   # renders PNGs with Electron, builds build/icon.icns with iconutil
```

### Packaging

```bash
npm run build:mac   # → dist/pr-hub-<version>-arm64.dmg
```

The DMG is **ad-hoc signed**: enough to run on Apple Silicon, but Gatekeeper will warn on first open. To distribute it, set a Developer ID `identity` in [electron-builder.yml](electron-builder.yml), enable `hardenedRuntime` and `notarize`, and build again.

## Configuration

Day-to-day options are in [Settings](#settings). These environment variables are mainly for development and testing:

| Variable           | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `PR_HUB_MODEL`     | Model for reviews when **Settings → Model** is blank, e.g. `haiku`, `sonnet` |
| `PR_HUB_SKILL_DIR` | Use this `pr-review` skill folder instead of searching `~/.claude/skills`    |
| `PR_HUB_USER_DATA` | Use another data folder (history, settings, reviews)                         |
| `PR_HUB_GH`        | Path to the `gh` binary to use (e.g. a test stand-in)                        |

Model precedence for a new review: **Settings → Model** if set, otherwise `PR_HUB_MODEL`, otherwise your Claude Code default. A malformed `PR_HUB_MODEL` is ignored. The timeout has no environment variable.

The app finds `claude` and `gh` on your **login shell's PATH**. Apps opened from Finder get a minimal PATH, so the app asks your shell for the full one. If you can run `claude` in a new terminal window, PR Hub can find it.

## Project structure

```
src/
  main/                     Electron main process (Node)
    index.ts                window, menu-bar icon, notifications, single instance, quit handling
    reviewRunner.ts         fetch + `claude -p` lifecycle: cancel, timeout, process groups
    prompt.ts               system prompt (skill) and review prompt with the findings contract
    streamParser.ts         stream-json lines → progress events and the final result
    extractFindings.ts      pulls and validates the findings JSON block
    environment.ts          login-shell PATH, finding claude, finding the skill
    reviewIpc.ts            review and history IPC, saving finished reviews, folder cleanup
    historyStore.ts         history.json: versioned, tolerant reads, crash-safe writes, pinned-aware retention
    historyIpc.ts           pin, delete (with confirmation) and export (save panel) for saved reviews
    historyExport.ts        one review → Markdown or the documented JSON export, redacted
    githubReview.ts         findings → GitHub review payload (diff lines, suggestions, sanitizing)
    githubPoster.ts         gh CLI: auth status, PR head/files, compare, review lookup, submit
    githubErrors.ts         gh/GitHub failures → specific guidance; token redaction
    githubHealth.ts         read-only connection check behind the form's GitHub status
    prInspect.ts            read-only PR/issue metadata for the form (gh or public API)
    githubIpc.ts            preview/post/verify/status IPC: submissions, duplicate prevention
    ipcGuard.ts             rejects IPC calls from anything but the app's page
    settings.ts             settings.json: migration, validation, atomic writes
    externalBrowser.ts      opens links in the chosen browser (bundle id, no shell), with fallback
    notifications.ts tray.ts windowState.ts bounds.ts replay.ts
  preload/index.ts          the typed window.api bridge
  renderer/src/             React UI
    App.tsx                 form ↔ history ↔ review view, shortcuts
    components/             ReviewForm, PrSummary, ReviewView, FindingsPanel, PostDialog, HistoryView, …
    review/                 reducer (state.ts), useReview hook, intake rules, formatting helpers
  shared/                   types and pure code used by both sides
    ipc.ts                  IPC channels and API types (source of truth)
    findings.ts history.ts github.ts validate.ts markdown.ts
scripts/                    review-cli.ts, render-icons.mjs
fixtures/                   recorded review stream, GitHub API responses, history file shapes
```

Tests sit next to the code as `*.test.ts`.

## Troubleshooting

**"Claude Code CLI not found"**
Install Claude Code and check that `claude --version` works in a **new** terminal window. PR Hub reads the PATH from your login shell (`$SHELL -ilc`).

**"pr-review skill not found"**
Make sure the skill exists under `~/.claude/skills` (any depth, as a folder named `pr-review` containing `SKILL.md`), or set `PR_HUB_SKILL_DIR`.

**"Couldn't fetch the PR"**
The repo is probably private: run `gh auth login`. Otherwise, check the link and your network. The error includes the fetch script's output.

**"GitHub CLI is not signed in"** when posting
Run `gh auth login`, then click **Try again** in the dialog.

**"Can't request changes on your own PR"**
GitHub only allows comments on PRs you opened. Click **Switch to Comment** in the dialog. The status panel also says "your PR" after a repository check.

**"N tool call(s) blocked"** in the footer
The reviewer tried something outside its sandbox, such as reading a file outside the review folder. That's expected now and then, and the review continues without it. Hover over the message to see what was blocked.

**`npm run dev` crashes with `Cannot read properties of undefined (reading 'isPackaged')`**
`ELECTRON_RUN_AS_NODE=1` is set in your environment. Some editor-integrated terminals and tools set it. Run `env -u ELECTRON_RUN_AS_NODE npm run dev`, or use a plain terminal.

**A review seems stuck**
Click **Cancel**. Reviews time out anyway, after 15 minutes unless you changed it in Settings. The raw event stream is in `reviews/<id>/stream.jsonl` in the data folder.

### GitHub connection

The **PR link** field has a GitHub status button: _Checking…_, _Connected as @you_, _Action needed_, _Not signed in to GitHub_ or _GitHub CLI unavailable_. Click it for details. With a PR link filled in, **Check access to owner/repo#n** checks whether your `gh` login can read that PR.

The check is read-only. It runs `gh --version`, `gh auth status` and one read of the PR. It never posts, and it never asks for, shows or stores your token. (`gh auth status` prints the token masked; PR Hub reads only its type: browser login, classic token, or fine-grained token.) Because nothing is posted, PR Hub can't _prove_ that posting will work. The **Posting** row is an estimate:

- _Should work:_ a browser login or classic token with the `repo` scope.
- _Can't be confirmed without posting:_ a fine-grained token or app token. Only GitHub knows its exact permissions.
- _Likely to fail:_ the login can't read the PR, or its scopes are too narrow.

Nothing here is required. Public PRs can be reviewed without `gh` or a login.

When a check or a post fails, PR Hub explains why and what to do. **Error details** shows GitHub's original message, with anything token-like removed.

**"Token can't post to this repository" / "Resource not accessible by personal access token (HTTP 403)"**
`gh` is using a fine-grained personal access token that can read the PR but can't create reviews on it. Edit the token on GitHub (Settings → Developer settings → Fine-grained tokens):

1. **Resource owner** must be the owner of the PR's base repository: your account, or the organization. A fine-grained token can't reach repositories owned by anyone else, even public ones.
2. **Repository access** must include the base repository (the one the PR merges into, not a fork).
3. **Repository permissions → Pull requests** must be **Read and write**.

Or switch `gh` to a browser login, which works for any repository your account can access: `gh auth login --hostname github.com --web`.

**"Token doesn't include this repository"**
Same token, but it can't even read the PR. Add the repository under **Repository access** (see above).

**"Organization approval needed"**
The organization restricts third-party access. An owner must approve the token request (Settings → Personal access tokens → Pending requests) or the GitHub CLI OAuth app.

**"Organization requires SSO authorization"**
For a token: on GitHub, open it, choose **Configure SSO**, and authorize the organization. For a browser login: run `gh auth login` again and complete the SSO step.

**"GitHub login is invalid or expired"**
Run `gh auth login`. If `GH_TOKEN` or `GITHUB_TOKEN` is set in your shell, update or remove it: `gh` uses it before its own login. The status panel shows "from GH_TOKEN" when that's the case.

**"GitHub rate limit reached"**
Wait and try again. `gh api rate_limit --jq .resources.core` shows when the limit resets.

**"Can't reach GitHub" / "GitHub did not respond in time"**
Check your network, VPN or proxy, and https://githubstatus.com. If a **post** times out, the review may still have been created: check the PR before posting again.

**"Inline comment positions are out of date"**
The PR changed after the preview was built, so a comment's line is no longer in the diff. Click **Try again** to rebuild the preview. Re-run the review to get inline comments on the new code.

## Limitations

- **macOS only, so far.** Cancelling relies on Unix process groups, and the build config, icons and login-shell PATH lookup assume macOS. `build:win` and `build:linux` scripts exist but are untested.
- **GitHub only.** The link must be a `github.com` PR.
- **One-line suggestions only.** Multi-line suggested fixes are posted as plain code, not one-click suggestions.
- **The skill is picked by date.** If several `pr-review` folders exist under `~/.claude/skills`, the most recently changed one is used; set `PR_HUB_SKILL_DIR` to pin one.
- **If the app crashes mid-review,** the `claude` process isn't stopped (quitting normally does stop it).
- **Unclear posts are tracked only while the app runs.** If you quit while a post's outcome is unclear, PR Hub forgets that submission; check the PR before posting again.
