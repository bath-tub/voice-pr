// Adapter: port a voice batch into the local containerized pogo orchestrator
// (mayor -> polecat -> refinery) instead of running `claude -p` directly.
//
// Transport is `docker exec` against the running orchestrator container. The
// voice batch becomes an `mg` work item whose --branch is the PR head, so the
// refinery fast-forward-merges the polecat's commits onto the PR branch. We
// then nudge the mayor to dispatch and track the item to a merge.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { run } from "./exec.js";

const CONTAINER = process.env.VOICE_PR_CONTAINER || "codingagent";
const WORKSPACE = process.env.VOICE_PR_WORKSPACE || "/home/pogo/workspace";
const POLL_MS = Number(process.env.VOICE_PR_POLL_MS || 10_000);
const DISPATCH_TIMEOUT_MS = Number(process.env.VOICE_PR_DISPATCH_MS || 12 * 60_000);
const DEFAULT_CLAUDE_CREDENTIAL_SERVICE = "Claude Code-credentials";
const DEFAULT_CLAUDE_AUTH_FILE = "~/.codingagent/secrets/claude-credentials.json";

/** docker exec (array form — no shell, so newlines/quotes in args are safe). */
function dx(args, opts = {}) {
  return run("docker", ["exec", "-u", "pogo", CONTAINER, ...args], opts);
}
async function dxJson(args) {
  const { stdout } = await dx(args);
  return JSON.parse(stdout);
}

/** Fail fast with a clear message if the orchestrator isn't reachable. */
export async function assertOrchestrator() {
  try {
    await dx(["pogo", "status", "--json"]);
  } catch (e) {
    throw new Error(
      `orchestrator container "${CONTAINER}" not reachable (${e.message.split("\n")[0]}). ` +
        `Is it running?  docker ps | grep ${CONTAINER}`
    );
  }
}

/**
 * Refresh the mounted Claude Code OAuth credentials before dispatch. This keeps
 * stale tokens from letting a voice-pr request file successfully and then stall
 * in mayor/polecat with 401s.
 */
export async function refreshClaudeAuth(emit = () => {}, opts = {}) {
  const env = opts.env || process.env;
  const mode = String(env.VOICE_PR_CLAUDE_AUTH_REFRESH || "auto").toLowerCase();
  if (["0", "false", "off", "never", "skip"].includes(mode)) {
    emit("agent-log", { line: "Claude auth refresh skipped by VOICE_PR_CLAUDE_AUTH_REFRESH" });
    return { refreshed: false, reason: "disabled" };
  }

  const dockerExec = opts.dx || dx;
  if (mode !== "always" && (await containerHasAnthropicApiKey(dockerExec))) {
    emit("agent-log", { line: "Claude auth refresh skipped; container has ANTHROPIC_API_KEY" });
    return { refreshed: false, reason: "api-key" };
  }

  const runHost = opts.run || run;
  const service = env.VOICE_PR_CLAUDE_AUTH_SERVICE || DEFAULT_CLAUDE_CREDENTIAL_SERVICE;
  const file = expandHome(env.VOICE_PR_CLAUDE_AUTH_FILE || DEFAULT_CLAUDE_AUTH_FILE, opts.homeDir || homedir());

  emit("agent-log", { line: `refreshing Claude OAuth credentials into ${file}` });
  let credential;
  try {
    const { stdout } = await runHost("security", ["find-generic-password", "-s", service, "-w"]);
    credential = stdout;
  } catch (e) {
    throw new Error(
      `could not refresh Claude OAuth credentials from macOS keychain service "${service}": ` +
        `${firstLine(e.message)}. Run Claude Code login/setup-token, set ANTHROPIC_API_KEY, ` +
        `or set VOICE_PR_CLAUDE_AUTH_REFRESH=never if this orchestrator uses another auth path.`
    );
  }

  if (!credential.trim()) {
    throw new Error(`Claude OAuth credential from keychain service "${service}" was empty`);
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, credential.endsWith("\n") ? credential : `${credential}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});

  await dockerExec(["pogo", "agent", "stop", "mayor"], { allowFail: true });
  emit("agent-log", { line: "refreshed Claude OAuth credentials and restarted mayor" });
  return { refreshed: true, file };
}

async function containerHasAnthropicApiKey(dockerExec) {
  try {
    const r = await dockerExec(["sh", "-lc", 'test -n "${ANTHROPIC_API_KEY:-}"'], {
      allowFail: true,
    });
    return r.code === 0;
  } catch {
    return false;
  }
}

function expandHome(path, homeDir) {
  return path === "~" ? homeDir : path.startsWith("~/") ? `${homeDir}${path.slice(1)}` : path;
}

function firstLine(s) {
  return String(s || "").split("\n")[0];
}

/**
 * Ensure the PR's repo exists in the container workspace on the head branch and
 * is registered as a pogo project. Returns the container-local repo path.
 */
export async function ensureProject({ owner, repo }, headRef, emit) {
  const path = `${WORKSPACE}/${repo}`;
  const exists = await dx(["test", "-d", `${path}/.git`], { allowFail: true });
  if (exists.code !== 0) {
    emit("cloning", { branch: headRef });
    // Clone over HTTPS; the container's git credential store carries GH_TOKEN.
    await dx([
      "git",
      "clone",
      "--branch",
      headRef,
      `https://github.com/${owner}/${repo}.git`,
      path,
    ]);
  } else {
    // Refresh the head branch so the polecat branches off origin's latest.
    await dx(["git", "-C", path, "fetch", "origin", headRef], { allowFail: true });
    await dx(["git", "-C", path, "checkout", headRef], { allowFail: true });
    await dx(["git", "-C", path, "reset", "--hard", `origin/${headRef}`], {
      allowFail: true,
    });
  }
  await dx(["pogo", "project", "add", path], { allowFail: true });
  emit("project-ready", { path });
  return path;
}

/** Create the work item; returns its id. (mg emits text: "Created <id>: <title>") */
export async function fileWorkItem({ repoPath, headRef, pr, body, title }) {
  const { stdout } = await dx([
    "mg",
    "new",
    "--repo",
    repoPath,
    "--branch",
    headRef,
    "--title",
    title,
    "--body",
    body,
    "--assignee",
    "mayor",
    "--priority",
    "high",
    "--type",
    "task",
    "--tag",
    "source=voice-pr",
    "--tag",
    `pr=${pr.number}`,
  ]);
  const id = extractId(stdout);
  if (!id) throw new Error(`could not parse work item id from: ${stdout.slice(0, 300)}`);
  return id;
}

/** Nudge the mayor to run a coordination cycle now (don't wait for its cron). */
export async function nudgeMayor(id) {
  await dx(
    [
      "pogo",
      "nudge",
      "mayor",
      `New high-priority voice-pr work item ${id} is available (assignee=mayor). ` +
        `Run a coordination cycle: dispatch a polecat for it now.`,
    ],
    { allowFail: true }
  );
}

/**
 * Track the work item to a terminal state, emitting progress. Resolves with
 * { status, refinery } where status is done/failed/timeout.
 */
export async function trackWorkItem(id, repoPath, emit) {
  const started = Date.now();
  let lastStatus = null;
  let renudged = false;

  for (;;) {
    if (Date.now() - started > DISPATCH_TIMEOUT_MS)
      return { status: "timeout", refinery: await refineryFor(id, repoPath) };

    const item = await showItem(id);
    const status = item?.status || "unknown";
    if (status !== lastStatus) {
      emit("work-status", { id, status });
      lastStatus = status;
    }

    // If the mayor hasn't picked it up halfway through, nudge once more.
    if (
      status === "available" &&
      !renudged &&
      Date.now() - started > DISPATCH_TIMEOUT_MS / 2
    ) {
      renudged = true;
      await nudgeMayor(id);
      emit("re-nudged", { id });
    }

    const ref = await refineryFor(id, repoPath);
    if (ref) emit("refinery", { id, status: ref.status });

    if (status === "done" || ref?.status === "merged")
      return { status: "done", item, refinery: ref };
    if (ref?.status === "failed")
      return { status: "failed", item, refinery: ref };

    await sleep(POLL_MS);
  }
}

async function showItem(id) {
  const r = await dx(["mg", "show", id], { allowFail: true });
  if (r.code !== 0) return null;
  // Text output: key/value lines including "Status:    <state>".
  const m = r.stdout.match(/^Status:\s*(\S+)/m);
  return { id, status: m ? m[1] : "unknown", raw: r.stdout };
}

/** Find this work item's most recent refinery merge request, if any. */
async function refineryFor(id, repoPath) {
  const r = await dx(["pogo", "refinery", "history", "--json"], { allowFail: true });
  if (r.code !== 0) return null;
  let hist;
  try {
    hist = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(hist) ? hist : hist.history || hist.requests || [];
  // Match on the polecat branch naming convention (polecat-<id>) or author.
  const mine = list.filter(
    (m) =>
      (m.branch && m.branch.includes(id)) ||
      (m.author && m.author.includes(id)) ||
      (m.id && String(m.id).includes(id))
  );
  return mine.length ? mine[mine.length - 1] : null;
}

function extractId(stdout) {
  // mg prints: "Created ca-11f8: <title>"
  const m = stdout.match(/Created\s+([a-z]+-[0-9a-f]+)/i);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
