import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

process.env.VOICE_PR_ARCHIVE_DIR = await mkdtemp(
  join(tmpdir(), "voice-pr-command-center-server-")
);
const { createBridgeServer } = await import("../server.js");

test("Q&A and follow-up routes invoke only their dedicated backend", async (t) => {
  const calls = [];
  const server = createBridgeServer({
    askQaFn: async (input) => {
      calls.push({ kind: "qa", input });
      return {
        threadId: input.threadId,
        answer: "One line.",
        agentId: "qa-agent",
        runId: "qa-run",
      };
    },
    createFollowupIssuesFn: async (input) => {
      calls.push({ kind: "followups", input });
      return {
        results: [
          {
            clientItemId: input.items[0].clientItemId,
            status: "created",
            issue: { number: 9, url: "https://github.com/o/r/issues/9" },
          },
        ],
      };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const qaResponse = await post(base, "/api/qa", {
    prRef: "o/r#7",
    threadId: "thread-1",
    question: "Why?",
  });
  assert.equal(qaResponse.status, 200);
  const qaJson = await qaResponse.json();
  assert.equal(qaJson.answer, "One line.");
  assert.ok(Number.isFinite(qaJson.metrics.qaMs));
  assert.deepEqual(calls.map((call) => call.kind), ["qa"]);

  const issueResponse = await post(base, "/api/followups/issues", {
    prRef: "o/r#7",
    confirmed: true,
    items: [{ clientItemId: "item-1", originalText: "Add a test" }],
  });
  assert.equal(issueResponse.status, 200);
  assert.equal((await issueResponse.json()).results[0].status, "created");
  assert.deepEqual(calls.map((call) => call.kind), ["qa", "followups"]);
});

test("new endpoints retain the localhost origin allowlist", async (t) => {
  let called = false;
  const server = createBridgeServer({
    askQaFn: async () => {
      called = true;
      return {};
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/qa`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ prRef: "o/r#7", question: "Why?" }),
    }
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://voice-pr-test",
    },
    body: JSON.stringify(body),
  });
}

test("bridge shutdown drains HTTP requests before disposing runtimes", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const closeAt = source.indexOf(
    "await new Promise((resolveClose) => server.close(resolveClose))"
  );
  const disposeAt = source.indexOf(
    "await Promise.all([agentRuntime.shutdown(), qaRuntime.shutdown()])"
  );
  assert.ok(closeAt >= 0);
  assert.ok(disposeAt > closeAt);
});
