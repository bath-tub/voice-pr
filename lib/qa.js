import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import {
  configuredModel,
  modelLabel,
  prepareWorkspace,
} from "./agent.js";
import { run } from "./exec.js";
import { parsePr, viewPr } from "./github.js";
import { buildQaPrompt } from "./prompt.js";
import { getTracer } from "./trace.js";

const DEFAULT_TTL_MS = Number(process.env.VOICE_PR_QA_TTL_MS || 15 * 60_000);
const DEFAULT_WORKSPACE_ROOT =
  process.env.VOICE_PR_QA_WORKSPACE_DIR ||
  join(homedir(), ".voice-pr", "qa-workspaces");
const DEFAULT_CACHE_ROOT =
  process.env.VOICE_PR_QA_REPO_CACHE_DIR ||
  join(homedir(), ".voice-pr", "qa-repo-cache");

export function createQaRuntime(options = {}) {
  const createAgent =
    options.createAgent || ((agentOptions) => Agent.create(agentOptions));
  const prepareWorkspaceFn = options.prepareWorkspace || prepareWorkspace;
  const runCommand = options.runCommand || run;
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const cacheRoot = options.cacheRoot || DEFAULT_CACHE_ROOT;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const sessions = new Map();
  const threadLocks = new Map();

  async function answer({
    pr,
    threadId: requestedThreadId,
    question,
    anchor = null,
    priorTurns = [],
    detailLevel = "concise",
    emit = () => {},
  }) {
    requireQuestion(question);
    const threadId = normalizeThreadId(requestedThreadId);
    const prIdentity = prKey(pr);
    const headRefOid = pr.headRefOid || "unknown-head";
    const key = `${prIdentity}:${headRefOid}:${threadId}`;
    const lockKey = `${prIdentity}:${threadId}`;
    const { entry, task } = await withThreadLock(lockKey, async () => {
      let selected = sessions.get(key);
      if (!selected) {
        const staleEntries = [...sessions.values()].filter(
          (candidate) =>
            candidate.prIdentity === prIdentity &&
            candidate.threadId === threadId &&
            candidate.headRefOid !== headRefOid
        );
        for (const stale of staleEntries) {
          sessions.delete(stale.key);
          clearTimeout(stale.timer);
          await Promise.resolve(stale.tail || stale.readyPromise).catch(() => {});
          await cleanup(stale);
          getTracer().event("qa.session.invalidated", {
            threadId,
            fromHeadSha: stale.headSha || stale.headRefOid,
            toHeadSha: headRefOid,
          });
        }
        selected = createEntry({ key, threadId, pr, emit });
        sessions.set(key, selected);
        selected.readyPromise = setup(selected).catch(async (error) => {
          if (sessions.get(key) === selected) sessions.delete(key);
          await cleanup(selected);
          throw error;
        });
      }

      clearTimeout(selected.timer);
      selected.pending++;
      const previous = selected.tail || Promise.resolve();
      const queued = previous
        .catch(() => {})
        .then(async () => {
          await selected.readyPromise;
          return runTurn(selected, {
            question,
            anchor,
            priorTurns,
            detailLevel: normalizeDetailLevel(detailLevel),
            emit,
          });
        });
      selected.tail = queued;
      return { entry: selected, task: queued };
    });
    return task.finally(() => {
      entry.pending--;
      if (entry.pending === 0 && sessions.get(entry.key) === entry)
        scheduleExpiry(entry);
    });
  }

  async function withThreadLock(key, task) {
    const previous = threadLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    threadLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (threadLocks.get(key) === current) threadLocks.delete(key);
    }
  }

  function createEntry({ key, threadId, pr, emit }) {
    const namespace = createHash("sha256").update(key).digest("hex").slice(0, 20);
    return {
      key,
      threadId,
      prIdentity: prKey(pr),
      headRefOid: pr.headRefOid || "unknown-head",
      namespace,
      sessionId: `qa-${namespace}`,
      pr,
      emit,
      agent: null,
      agentId: null,
      workspace: null,
      mirror: null,
      localBranch: null,
      headSha: null,
      turn: 0,
      pending: 0,
      tail: null,
      timer: null,
      closed: false,
    };
  }

  async function setup(entry) {
    const tracer = getTracer();
    tracer.event("qa.session.preparing", {
      threadId: entry.threadId,
      pr: prKey(entry.pr),
    });
    const prepared = await prepareWorkspaceFn({
      sessionId: entry.sessionId,
      pr: entry.pr,
      workspaceRoot,
      cacheRoot,
      runCommand,
      emit: entry.emit,
      branchPrefix: "voice-pr-qa",
    });
    entry.workspace = prepared.path || prepared.workspace;
    entry.mirror = prepared.mirror;
    entry.localBranch = prepared.localBranch;
    entry.headSha = prepared.headSha;
    await assertReadOnlySnapshot(entry, "before Q&A agent creation");

    const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
    if (!apiKey)
      throw new Error("CURSOR_API_KEY is required for the Cursor SDK Q&A agent");
    const model = configuredModel(options);
    entry.agent = await createAgent({
      apiKey,
      name: `voice-pr Q&A ${entry.pr.owner}/${entry.pr.repo}#${entry.pr.number}`,
      model,
      mode: "plan",
      idempotencyKey: `voice-pr:qa:${entry.namespace}:agent`,
      local: {
        cwd: entry.workspace,
        autoReview: true,
        settingSources: options.settingSources ?? [],
        sandboxOptions: { enabled: true },
        enableAgentRetries: true,
      },
    });
    entry.agentId = entry.agent.agentId;
    tracer.event("qa.session.ready", {
      threadId: entry.threadId,
      agentId: entry.agentId,
      headSha: entry.headSha,
      model: modelLabel(model),
    });
  }

  async function runTurn(entry, input) {
    const tracer = getTracer();
    const turn = entry.turn + 1;
    await assertReadOnlySnapshot(entry, "before Q&A turn");
    input.emit("qa-running", {
      threadId: entry.threadId,
      agentId: entry.agentId,
      turn,
    });
    tracer.event("qa.run.start", {
      threadId: entry.threadId,
      agentId: entry.agentId,
      turn,
      anchored: !!input.anchor,
      detailLevel: input.detailLevel,
    });

    try {
      const sdkRun = await entry.agent.send(
        buildQaPrompt({
          pr: entry.pr,
          question: input.question,
          anchor: input.anchor,
          priorTurns: input.priorTurns,
          detailLevel: input.detailLevel,
          workspaceHead: entry.headSha,
        }),
        {
          mode: "plan",
          idempotencyKey: `voice-pr:qa:${entry.namespace}:turn:${turn}`,
        }
      );
      const result = await sdkRun.wait();
      await assertReadOnlySnapshot(entry, "after Q&A turn");
      assertFinished(result);
      entry.turn = turn;
      const answerText = formatAnswer(result.result, input.detailLevel);
      tracer.event("qa.run.done", {
        threadId: entry.threadId,
        agentId: entry.agentId,
        runId: sdkRun.id,
        turn,
      });
      return {
        backend: "cursor-sdk",
        threadId: entry.threadId,
        answer: answerText,
        detailLevel: input.detailLevel,
        agentId: entry.agentId,
        runId: sdkRun.id,
      };
    } catch (error) {
      tracer.error("qa.run.error", error, {
        threadId: entry.threadId,
        agentId: entry.agentId,
        turn,
      });
      sessions.delete(entry.key);
      await cleanup(entry);
      throw error;
    }
  }

  function scheduleExpiry(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      if (sessions.get(entry.key) !== entry) return;
      sessions.delete(entry.key);
      await cleanup(entry);
      getTracer().event("qa.session.expired", {
        threadId: entry.threadId,
        agentId: entry.agentId,
      });
    }, ttlMs);
    entry.timer.unref?.();
  }

  async function assertReadOnlySnapshot(entry, phase) {
    const status = await runCommand("git", ["status", "--porcelain"], {
      cwd: entry.workspace,
    });
    const dirty = status.stdout.trim();
    if (dirty)
      throw new Error(
        `read-only Q&A workspace became dirty ${phase}: ${dirty.split("\n")[0]}`
      );
    const head = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: entry.workspace })
    ).stdout.trim();
    if (head !== entry.headSha)
      throw new Error(
        `read-only Q&A workspace HEAD changed ${phase}: expected ${entry.headSha}, got ${head}`
      );
  }

  async function cleanup(entry) {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.timer);
    if (entry.agent) {
      const agent = entry.agent;
      entry.agent = null;
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        try {
          agent.close();
        } catch {}
      }
    }
    if (entry.workspace && entry.mirror) {
      await runCommand(
        "git",
        [
          "--git-dir",
          entry.mirror,
          "worktree",
          "remove",
          "--force",
          entry.workspace,
        ],
        { allowFail: true }
      ).catch(() => {});
      if (entry.localBranch)
        await runCommand(
          "git",
          ["--git-dir", entry.mirror, "branch", "-D", entry.localBranch],
          { allowFail: true }
        ).catch(() => {});
    }
  }

  async function shutdown() {
    const entries = [...sessions.values()];
    sessions.clear();
    await Promise.all(entries.map(cleanup));
  }

  function status(pr, threadId) {
    const identity = prKey(pr);
    const entry = [...sessions.values()].find(
      (candidate) =>
        candidate.prIdentity === identity &&
        candidate.threadId === threadId &&
        (!pr.headRefOid || candidate.headRefOid === pr.headRefOid)
    );
    return entry
      ? {
          threadId: entry.threadId,
          agentId: entry.agentId,
          turns: entry.turn,
          headSha: entry.headSha,
        }
      : null;
  }

  return { answer, status, shutdown };
}

export async function resolveQaPr(prRef) {
  const pr = parsePr(prRef);
  const meta = await viewPr(pr);
  Object.assign(pr, {
    title: meta.title,
    url: meta.url,
    body: meta.body || "",
    state: meta.state,
    isCrossRepository: meta.isCrossRepository,
    headRefName: meta.headRefName,
    headRefOid: meta.headRefOid,
    baseRefName: meta.baseRefName,
  });
  if (pr.state !== "OPEN")
    throw new Error(`PR #${pr.number} is ${pr.state}, not open`);
  if (pr.isCrossRepository)
    throw new Error("cross-repository (fork) PRs aren't supported for Q&A");
  return pr;
}

export async function askQa(
  input,
  emit = () => {},
  { runtime = qaRuntime, resolvePr = resolveQaPr } = {}
) {
  const pr = await resolvePr(input.prRef);
  return runtime.answer({
    pr,
    threadId: input.threadId || input.sessionId,
    question: input.question,
    anchor: input.anchor || null,
    priorTurns: Array.isArray(input.priorTurns)
      ? input.priorTurns
      : Array.isArray(input.turns)
        ? input.turns
        : [],
    detailLevel: input.detailLevel,
    emit,
  });
}

function requireQuestion(question) {
  const value = String(question || "").trim();
  if (!value) throw new Error("question is required");
  if (value.length > 10_000) throw new Error("question exceeds 10000 characters");
}

function normalizeThreadId(value) {
  const id = String(value || randomUUID()).trim();
  if (!id) throw new Error("threadId must not be empty");
  if (id.length > 200) throw new Error("threadId exceeds 200 characters");
  return id;
}

function normalizeDetailLevel(value) {
  return value === "expanded" ? "expanded" : "concise";
}

function formatAnswer(value, detailLevel) {
  const answer = String(value || "").trim();
  if (!answer) throw new Error("Cursor Q&A agent returned an empty answer");
  if (!/\[(?:PR #\d+|[^\]\r\n]+:\d+(?:-\d+)?)\]/.test(answer))
    throw new Error("Cursor Q&A agent returned an answer without an evidence citation");
  return detailLevel === "expanded"
    ? answer
    : answer.replace(/\s+/g, " ").trim();
}

function assertFinished(result) {
  if (result?.status === "finished") return;
  const detail =
    result?.error?.message || result?.result || result?.status || "unknown error";
  throw new Error(`Cursor Q&A run failed: ${detail}`);
}

function prKey(pr) {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export const qaRuntime = createQaRuntime();
