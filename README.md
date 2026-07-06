# voice-pr

**Scroll your PR diff in Chrome and talk. Walk away. Come back to commits.**

You're on your PR's *Files changed* tab. You hit record, scroll through the
diff, and just say what you think — "this retry needs backoff… rename this
var… why are we fetching twice here." Each comment is **anchored to the file+line
you were looking at when you said it**, enriched with the ticket / Slack / CI
context, batched into one task, and handed to your **orchestrator** to do the
work. Minutes later the PR has real commits.

```
  Chrome extension on the PR page
    ● record → scroll + talk → each chunk anchored to the viewport's file:line
        │  (+ auto-pull: Jira ticket, Slack threads, CI status)
        ▼  POST /api/session
  local bridge (this Node server)  ──►  pogo orchestrator
        │                                 mayor → polecat (worktree) → refinery
        │                                 └─ commits merged onto the PR branch
        ▼
  bridge posts the intent-trail comment on the PR after the merge
```

There are **two front-ends** over the same bridge + orchestrator:
1. **Chrome extension** (`extension/`) — the real UX, on the GitHub PR page. *Start here.*
2. **Localhost page** (`public/`) — a paste-a-URL fallback for quick tests / no-extension use.

The extension is a content script (`content.js`, the PR-page UI + viewport
anchoring) plus a **background service worker** (`background.js`) that makes the
bridge calls. That split is load-bearing: Chrome blocks a content script from
fetching the `localhost` loopback directly, so all bridge traffic goes through
the worker (extension context, covered by `host_permissions`). Verified live in
Chrome — injection, viewport anchoring on GitHub's real diff DOM, the context
call, and session streaming all exercised end-to-end.

## The design (decided in a grill-me session)

| Decision | Choice |
|---|---|
| **Who speaks** | The PR **author**, dictating changes to their **own** PR. |
| **Source of truth** | The **pushed head branch** — exactly what you see on GitHub. You're in a browser, not editing locally, so there's no working-tree collision. |
| **What comments are for** | An **anchored intent trail**: each committed change gets a comment pinned to the line, explaining why it changed and linking the commit. They stay as a record. |
| **Confident items** | Real edits, **one commit per item**, pushed to the branch. |
| **Unclear items** | **Not acted on.** Batched into one comment saying your direction wasn't clear enough — so a wrong guess never lands silently. |
| **Activation** | **Explicit** — click record in the extension, then scroll + talk. No always-on mic. |
| **Anchoring** | **Auto from viewport** — each spoken chunk pins to the `file:line` centered on screen when you said it. Say "over in utils…" and the agent follows meaning over the anchor. |
| **Context** | On session start the bridge detects the **Jira key** + **CI status**; the polecat pulls the **ticket** and **Slack** threads via its MCP tools at work-time. |
| **Execution** | Via the **orchestrator** (mayor → polecat in a worktree → refinery merge onto the PR branch). Localhost fallback uses `claude` headless in an isolated clone. Never force-pushes, rebases, or amends. |
| **Safety net** | Everything lands as **commits you review before merge**; unclear work is surfaced as a comment, not guessed. |

## Quick start (Chrome extension)

```bash
# 1. Start the bridge (talks to gh + your orchestrator container)
node server.js                      # → http://localhost:4100
```

2. Load the extension **once**: open `chrome://extensions`, turn on
   **Developer mode**, click **Load unpacked**, and pick the `extension/`
   folder. (Chrome won't let anything auto-install a local extension — this one
   manual step is unavoidable.)
3. Open any PR's **Files changed** tab on GitHub. A **🎙️ Review with voice**
   pill appears bottom-right.
4. Click it → **Start recording** → scroll and talk. Each comment shows the
   `file:line` it anchored to. (First time, Chrome asks for mic permission on
   github.com. No mic / not Chrome? Type comments into the box instead — same
   result.)
5. **Hand to orchestrator →**. Close the tab if you want; the PR updates in a
   few minutes. The panel also streams live progress and links the result.

The extension always routes through the **orchestrator** backend, so the bridge
must be able to reach your pogo container (see below).

## Speech-to-text: local Whisper (private, accurate)

Transcription runs **locally** through `whisper.cpp` on the bridge — audio never
leaves the machine (right call for PR code). The extension records audio + an
anchor timeline; on stop it hands both to the bridge, which transcribes with
Whisper (segment timestamps) and maps each spoken phrase back to the file/line/
selection that was active when you said it.

Setup (one-time):
```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/.cache/whisper
curl -fsSL -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```
`large-v3-turbo-q5_0` (~547MB) runs faster-than-realtime on Apple Silicon and is
far more accurate than the browser's Web Speech API for technical speech. Swap
the model via `VOICE_PR_WHISPER_MODEL`.

## Requirements

- **Node ≥ 20** (bridge uses only built-ins — no `npm install`).
- **`gh` CLI**, authenticated with push access to the target repo.
- **`whisper-cli` + `ffmpeg`** + a GGML model (see above) for transcription.
- A running **pogo orchestrator container** (`codingagent`) for the extension
  path — see "orchestrator backend" below. (The localhost `direct` fallback
  instead needs the **`claude` CLI** authenticated.)
- **Chrome** for the extension + mic.

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

## Two backends

voice-pr can execute a batch in one of two ways, selected by `VOICE_PR_BACKEND`:

### `direct` (default)
Runs `claude -p` in an isolated clone on the host, commits per item, pushes,
and posts the anchored comments itself. Self-contained; nothing else required.

### `orchestrator` — ports voice-pr into the containerized pogo loop
Instead of running the agent itself, voice-pr becomes a **producer of work
items** for a locally running pogo orchestrator container (mayor → polecat →
refinery). The adapter (`lib/orchestrator.js`, transport = `docker exec`):

1. **Clones** the PR's repo into the container workspace on the head branch and
   registers it (`pogo project add`).
2. **Files a work item** — `mg new --repo <container-path> --branch <PR-head>
   --assignee mayor --tag source=voice-pr`. Setting `--branch` to the PR head is
   the key: the refinery's merge `--target` becomes the PR branch, so the
   polecat's commits land **on the PR**.
3. **Nudges the mayor** to run a coordination cycle now (`pogo nudge mayor`).
4. **Tracks** the item (`mg show`, `pogo refinery history`) through
   claim → commit → refinery gates → fast-forward merge, emitting the same
   progress-event shape the UI already renders.

The work-item body (`buildOrchestratorBody`) carries the voice-pr conventions
into the polecat: segment the transcript, confidence-gate, one commit per
confident item, and — after merge — post the anchored intent-trail comments and
a clarification comment for anything too vague. The polecat template already
owns the claim / commit / `refinery submit` / done protocol.

```bash
VOICE_PR_BACKEND=orchestrator PORT=4100 node server.js
```

**Orchestrator credential note (operational):** the pogo container's Claude auth
is wired in at `docker run` time (an OAuth token copied into a bind-mounted
file, or `ANTHROPIC_API_KEY`). Before each orchestrator dispatch, voice-pr now
refreshes the mounted OAuth file from the local Claude Code keychain service
(`Claude Code-credentials`) and restarts the mayor so it re-reads the token:
`security find-generic-password -s "Claude Code-credentials" -w >
~/.codingagent/secrets/claude-credentials.json`, then `pogo agent stop mayor`.
If the container has `ANTHROPIC_API_KEY`, the refresh is skipped because API-key
auth avoids OAuth expiry. If the keychain lookup fails, the request fails before
filing work instead of leaving a queued item to stall on 401s.

## Config

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4100` | HTTP port |
| `VOICE_PR_BACKEND` | `direct` | `direct` (host `claude -p`) or `orchestrator` (pogo loop) |
| `VOICE_PR_MODEL` | `claude-sonnet-5` | model for the headless agent (direct backend) |
| `VOICE_PR_TIMEOUT_MS` | `360000` | agent timeout per batch (direct backend) |
| `VOICE_PR_CONTAINER` | `codingagent` | orchestrator container name |
| `VOICE_PR_WORKSPACE` | `/home/pogo/workspace` | repo checkout root inside the container |
| `VOICE_PR_DISPATCH_MS` | `720000` | how long to track a work item before returning |
| `VOICE_PR_CLAUDE_AUTH_REFRESH` | `auto` | `auto`, `always`, or `never`; controls the orchestrator OAuth refresh preflight |
| `VOICE_PR_CLAUDE_AUTH_SERVICE` | `Claude Code-credentials` | macOS keychain service to read for OAuth credentials |
| `VOICE_PR_CLAUDE_AUTH_FILE` | `~/.codingagent/secrets/claude-credentials.json` | host path for the bind-mounted Claude credential file |
| `VOICE_PR_WHISPER_BIN` | `whisper-cli` | whisper.cpp binary |
| `VOICE_PR_WHISPER_MODEL` | `~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin` | GGML model path |
| `VOICE_PR_ARCHIVE_DIR` | `~/.voice-pr/sessions` | where session fixtures are saved |

## Session archive (fixtures)

Every session is saved under `VOICE_PR_ARCHIVE_DIR/<sessionId>/` for replay,
test cases, and examples:
- `audio.<ext>` — the raw recording
- `transcript.json` — raw text, anchored segments, whisper segment timestamps, the anchor timeline
- `session.json` — the dispatched segments, every orchestrator progress event, and the final result

The `sessionId` (minted by the extension at record-start) correlates the
recording, its transcript, and the orchestrator run it produced.

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
- **Extension anchoring targets GitHub's current diff DOM** — if the mic is
  blocked by a page `Permissions-Policy` or GitHub restructures the diff markup,
  anchoring degrades to file-only or no anchor (the agent then infers location
  from the words + context). The typed-comment box always works as a fallback.
- **Context depth is delegated** — the bridge only detects the Jira key + CI
  cheaply; the actual ticket/Slack reads happen inside the polecat via MCP, so
  they only enrich the work, not the live UI. A richer live "context found"
  panel would need the bridge itself to hold those integrations.
