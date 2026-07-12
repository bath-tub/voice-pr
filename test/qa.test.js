import assert from "node:assert/strict";
import test from "node:test";
import { askQa, createQaRuntime } from "../lib/qa.js";

const HEAD = "a".repeat(40);
const pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "Add retry",
  url: "https://github.com/o/r/pull/7",
  headRefName: "feat/retry",
  headRefOid: HEAD,
};

function harness({
  ttlMs = 60_000,
  mutate = false,
  moveHead = false,
  settingSources,
  resultText =
    "The anchor calls retry().\nIt uses exponential backoff. [lib/net.js:12]",
} = {}) {
  const created = [];
  const sends = [];
  const commands = [];
  const preparations = [];
  const headsByWorkspace = new Map();
  let prepareCount = 0;
  let disposed = 0;
  let runFinished = false;

  const runtime = createQaRuntime({
    apiKey: "test-key",
    model: "test-model",
    ttlMs,
    workspaceRoot: "/tmp/voice-pr-qa-tests/workspaces",
    cacheRoot: "/tmp/voice-pr-qa-tests/cache",
    ...(settingSources === undefined ? {} : { settingSources }),
    async prepareWorkspace(input) {
      prepareCount++;
      preparations.push(input);
      const path = `/tmp/voice-pr-qa-tests/workspaces/${input.sessionId}`;
      const preparedHead = input.pr.headRefOid || HEAD;
      headsByWorkspace.set(path, preparedHead);
      return {
        path,
        mirror: "/tmp/voice-pr-qa-tests/cache/o--r.git",
        localBranch: `voice-pr-qa/${input.sessionId}`,
        headSha: preparedHead,
      };
    },
    async createAgent(options) {
      created.push(options);
      return {
        agentId: "qa-agent-1",
        async send(prompt, sendOptions) {
          sends.push({ prompt, options: sendOptions });
          return {
            id: `qa-run-${sends.length}`,
            async wait() {
              runFinished = true;
              return {
                status: "finished",
                result: resultText,
              };
            },
          };
        },
        close() {},
        async [Symbol.asyncDispose]() {
          disposed++;
        },
      };
    },
    async runCommand(cmd, args, options = {}) {
      commands.push({ cmd, args, options });
      const joined = args.join(" ");
      if (joined === "status --porcelain")
        return {
          code: 0,
          stdout: runFinished && mutate ? " M lib/net.js\n" : "",
          stderr: "",
        };
      if (joined === "rev-parse HEAD")
        return {
          code: 0,
          stdout: `${
            runFinished && moveHead
              ? "b".repeat(40)
              : headsByWorkspace.get(options.cwd) || HEAD
          }\n`,
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  return {
    runtime,
    created,
    sends,
    commands,
    preparations,
    prepareCount: () => prepareCount,
    disposed: () => disposed,
  };
}

test("Q&A uses Plan mode, sandboxing, anchor-first prompts, and a dedicated workspace", async () => {
  const h = harness();
  const result = await h.runtime.answer({
    pr,
    threadId: "thread-1",
    question: "What does this call do?",
    anchor: { file: "lib/net.js", line: 12, snippet: "retry(request)" },
    priorTurns: [{ role: "assistant", content: "It retries transient errors." }],
  });

  assert.equal(result.answer.includes("\n"), false, "concise answers are one line");
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].mode, "plan");
  assert.equal(h.created[0].local.sandboxOptions.enabled, true);
  assert.equal(h.created[0].local.autoReview, true);
  assert.deepEqual(
    h.created[0].local.settingSources,
    [],
    "Q&A must not load ambient user, team, project, or plugin settings"
  );
  assert.equal("mcpServers" in h.created[0], false);
  assert.equal("customTools" in h.created[0].local, false);
  assert.equal(h.sends[0].options.mode, "plan");
  assert.match(h.sends[0].options.idempotencyKey, /:turn:1$/);
  assert.ok(
    h.sends[0].prompt.indexOf("## Anchor") <
      h.sends[0].prompt.indexOf("## PR")
  );
  assert.match(h.sends[0].prompt, /never implement, apply/i);
  assert.match(h.sends[0].prompt, /never commit, amend, rebase, push, comment, create issues/i);
  assert.match(h.sends[0].prompt, /lib\/net\.js:12/);
  assert.equal(h.preparations[0].branchPrefix, "voice-pr-qa");
  assert.match(h.preparations[0].workspaceRoot, /qa-tests\/workspaces/);
  assert.match(h.preparations[0].cacheRoot, /qa-tests\/cache/);
  assert.ok(!h.commands.some((call) => call.args.includes("push")));
  await h.runtime.shutdown();
});

test("Q&A preserves an explicit settingSources override for controlled tests", async () => {
  const h = harness({ settingSources: ["user"] });
  await h.runtime.answer({
    pr,
    threadId: "thread-settings-override",
    question: "What does this do?",
  });
  assert.deepEqual(h.created[0].local.settingSources, ["user"]);
  await h.runtime.shutdown();
});

test("Q&A reuses one thread agent, supports expanded answers, and expires cleanly", async () => {
  const h = harness({ ttlMs: 5 });
  await h.runtime.answer({
    pr,
    threadId: "thread-reuse",
    question: "What changed?",
  });
  const second = await h.runtime.answer({
    pr,
    threadId: "thread-reuse",
    question: "Why?",
    detailLevel: "expanded",
  });

  assert.equal(h.created.length, 1);
  assert.equal(h.prepareCount(), 1);
  assert.equal(h.sends.length, 2);
  assert.match(second.answer, /\n/);
  assert.equal(h.runtime.status(pr, "thread-reuse").turns, 2);

  await waitFor(() => h.runtime.status(pr, "thread-reuse") === null);
  assert.equal(h.disposed(), 1);
  assert.ok(
    h.commands.some((call) =>
      call.args.join(" ").includes("worktree remove --force")
    )
  );
});

test("Q&A invalidates a reused thread when the PR head changes", async () => {
  const h = harness();
  await h.runtime.answer({
    pr,
    threadId: "thread-drift",
    question: "What changed?",
  });
  const nextHead = "b".repeat(40);
  await h.runtime.answer({
    pr: { ...pr, headRefOid: nextHead },
    threadId: "thread-drift",
    question: "What changed now?",
  });

  assert.equal(h.prepareCount(), 2);
  assert.equal(h.created.length, 2);
  assert.equal(h.disposed(), 1);
  assert.match(h.sends[1].prompt, new RegExp(nextHead));
  await h.runtime.shutdown();
});

test("concurrent turns on a new head share one replacement session", async () => {
  const h = harness();
  await h.runtime.answer({
    pr,
    threadId: "thread-concurrent-drift",
    question: "What changed?",
  });
  const nextPr = { ...pr, headRefOid: "c".repeat(40) };
  await Promise.all([
    h.runtime.answer({
      pr: nextPr,
      threadId: "thread-concurrent-drift",
      question: "What changed now?",
    }),
    h.runtime.answer({
      pr: nextPr,
      threadId: "thread-concurrent-drift",
      question: "Why did it change?",
    }),
  ]);

  assert.equal(h.prepareCount(), 2);
  assert.equal(h.created.length, 2);
  assert.equal(h.sends.length, 3);
  assert.equal(h.disposed(), 1);
  await h.runtime.shutdown();
  assert.equal(h.disposed(), 2);
});

test("Q&A rejects and cleans any dirty workspace mutation", async () => {
  const h = harness({ mutate: true });
  await assert.rejects(
    h.runtime.answer({
      pr,
      threadId: "thread-dirty",
      question: "Can this be simplified?",
    }),
    /read-only Q&A workspace became dirty after Q&A turn/
  );
  assert.equal(h.runtime.status(pr, "thread-dirty"), null);
  assert.equal(h.disposed(), 1);
  assert.ok(!h.commands.some((call) => call.args.includes("push")));
});

test("Q&A rejects and cleans a changed HEAD", async () => {
  const h = harness({ moveHead: true });
  await assert.rejects(
    h.runtime.answer({
      pr,
      threadId: "thread-head",
      question: "What is this?",
    }),
    /read-only Q&A workspace HEAD changed after Q&A turn/
  );
  assert.equal(h.runtime.status(pr, "thread-head"), null);
  assert.equal(h.disposed(), 1);
});

test("Q&A rejects uncited model answers", async () => {
  const h = harness({ resultText: "It uses exponential backoff." });
  await assert.rejects(
    h.runtime.answer({
      pr,
      threadId: "thread-uncited",
      question: "What does this do?",
    }),
    /without an evidence citation/
  );
  assert.equal(h.runtime.status(pr, "thread-uncited"), null);
  assert.equal(h.disposed(), 1);
});

test("askQa calls only the dedicated Q&A runtime", async () => {
  const calls = [];
  const runtime = {
    async answer(input) {
      calls.push(input);
      return { threadId: input.threadId, answer: "answer" };
    },
  };
  const result = await askQa(
    {
      prRef: pr.url,
      threadId: "isolated",
      question: "Why?",
      turns: [{ role: "reviewer", content: "Earlier" }],
    },
    () => {},
    { runtime, resolvePr: async () => pr }
  );
  assert.equal(result.answer, "answer");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].priorTurns.length, 1);
  assert.equal(typeof runtime.preparePr, "undefined");
  assert.equal(typeof runtime.execute, "undefined");
});

test("Q&A rejects oversized questions before preparing a workspace", async () => {
  const h = harness();
  await assert.rejects(
    h.runtime.answer({
      pr,
      threadId: "oversized",
      question: "x".repeat(10_001),
    }),
    /exceeds 10000 characters/
  );
  assert.equal(h.prepareCount(), 0);
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for condition");
}
