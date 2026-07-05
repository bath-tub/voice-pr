# voice-pr

Speak your feedback at your own GitHub PR. Walk away. Come back to commits.

You're reviewing your own pull request on GitHub, you notice a few things, and
instead of context-switching into your editor to fix them, you just **say them
out loud**. A few minutes later the PR has real commits addressing each clear
point, each pinned with a comment explaining *why* that line changed — and a
single comment listing anything you were too vague about.

```
  you (on the PR):  "make the retry loop back off exponentially,
                     rename fooSvc to paymentClient, and add a null
                     check for amount. also that widget thing, make it nicer."
        │
        ▼  transcribe (browser) → segment → confidence-gate
  ┌─────────────────────────────────────────────────────────────┐
  │  confident items          →  edit in isolated worktree,      │
  │   (backoff, rename, guard)   one commit each, push,          │
  │                              anchored intent-trail comment   │
  │  unclear item ("widget")  →  one "your direction wasn't      │
  │                              clear enough" PR comment        │
  └─────────────────────────────────────────────────────────────┘
```

## The design (decided in a grill-me session)

| Decision | Choice |
|---|---|
| **Who speaks** | The PR **author**, dictating changes to their **own** PR. |
| **Source of truth** | The **pushed head branch** — exactly what you see on GitHub. You're in a browser, not editing locally, so there's no working-tree collision. |
| **What comments are for** | An **anchored intent trail**: each committed change gets a comment pinned to the line, explaining why it changed and linking the commit. They stay as a record. |
| **Confident items** | Real edits, **one commit per item**, pushed to the branch. |
| **Unclear items** | **Not acted on.** Batched into one comment saying your direction wasn't clear enough — so a wrong guess never lands silently. |
| **Activation** | **Explicit** — hold `Space` / click to talk. No always-on mic. |
| **Execution** | **Isolated clone/worktree** off branch HEAD (co-author model); the agent is `claude` headless. Never force-pushes, rebases, or amends. |
| **Safety net** | Everything lands as **commits you review before merge**; unclear work is surfaced, not guessed. |

## Requirements

- **Node ≥ 20** (uses only built-ins — no `npm install`).
- **`claude` CLI**, authenticated (it's the code-editing agent, run headless).
- **`gh` CLI**, authenticated with push access to the target repo.
- **Chrome** for the browser mic (Web Speech API). Other browsers: type instead.

## Run

```bash
node server.js            # → http://localhost:4100  (set PORT to change)
```

Open it in Chrome, paste your PR URL, hold **Space** (or click) and talk, edit
the transcript if a word came out wrong, then hit **Address my feedback →**.
Progress streams live, but the whole point is you can close the tab — it runs
asynchronously and the PR updates in a few minutes.

### Try it against a throwaway PR

```bash
npm run demo              # creates bath-tub/voice-pr-demo + opens a fresh PR
```

It prints a PR URL and a suggested thing to say (with one deliberately vague
item so you can see the clarification path). Nothing real is touched.

## How it works

1. **`server.js`** — dependency-free Node HTTP server. Serves the mic UI and
   streams batch progress back as newline-delimited JSON.
2. **`public/`** — the mic UI. `webkitSpeechRecognition` transcribes in-browser;
   push-to-talk; the transcript is editable before you fire.
3. **`lib/pipeline.js`** — one batch end-to-end: parse PR → `gh pr view/diff` →
   clone the head branch into a temp dir → run `claude -p` there → read the
   agent's manifest → `git push` → post anchored comments (+ one clarification
   comment) via `gh`.
4. **`lib/prompt.js`** — instructs the agent to segment the transcript,
   confidence-gate each item, make one commit per confident item, and write a
   strict JSON manifest (`file`, `line`, `commitSha`, `rationale`, or a
   `clarification` for low-confidence items).
5. **`lib/github.js`** — PR parsing + `gh` operations. Inline review comments
   fall back to a plain PR comment if a line isn't part of the diff hunk.

## Config

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4100` | HTTP port |
| `VOICE_PR_MODEL` | `claude-sonnet-5` | model for the headless agent |
| `VOICE_PR_TIMEOUT_MS` | `360000` | agent timeout per batch |

## Known MVP limits (next passes)

- **Same-repo PRs only** — fork/cross-repo head branches are rejected (would
  need a remote-add + push-to-fork path).
- **Confidence ≠ correctness.** The agent can be confidently wrong; the backstop
  is that everything is a reviewable commit, never an auto-merge. A verify step
  (build/test the agent's commits before pushing) is the obvious next guard.
- **No concurrency control** — fire a second batch before the first finishes and
  two agents race on the same branch. Real version needs a per-branch queue.
- **Browser speech only** — Web Speech API (Chrome). A server-side transcription
  path (e.g. Whisper) would make it browser-agnostic.
- **One commit per item** assumes items are independent; overlapping edits to the
  same lines aren't ordered.
