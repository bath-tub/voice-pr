import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadState() {
  const source = await readFile(new URL("../extension/diffy-state.js", import.meta.url), "utf8");
  const context = { globalThis: {}, URL, Date, Math };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.DiffyState;
}

test("canonicalizes every GitHub PR subroute to one PR-local key", async () => {
  const { parsePrUrl, prStateKey } = await loadState();
  const files = parsePrUrl("https://github.com/acme/payments/pull/42/files#diff-aR10");
  const checks = parsePrUrl("https://github.com/acme/payments/pull/42/checks");
  assert.deepEqual(plain(files), {
    owner: "acme",
    repo: "payments",
    number: "42",
    prUrl: "https://github.com/acme/payments/pull/42",
    id: "acme/payments#42",
  });
  assert.equal(prStateKey(files), prStateKey(checks));
  assert.equal(parsePrUrl("https://github.com/acme/payments/issues/42"), null);
});

test("Q&A remains a short durable thread and never changes the active screen", async () => {
  const { initialState, reducer } = await loadState();
  let state = reducer(initialState(), { type: "NAVIGATE", screen: "ask" });
  state = reducer(state, {
    type: "QA_ASK",
    id: "q1",
    threadId: "thread-1",
    question: "What changed?",
    anchor: { file: "src/a.js", line: 12 },
    at: 1,
  });
  state = reducer(state, {
    type: "QA_ANSWER",
    id: "q1",
    answer: "The retry became bounded.",
  });
  assert.equal(state.screen, "ask");
  assert.equal(state.qa.threadId, "thread-1");
  assert.equal(state.qa.items[0].status, "answered");
  assert.equal(state.qa.items[0].anchor.file, "src/a.js");
});

test("PR navigation settles pending questions before restoring another PR", async () => {
  const { initialState, reducer } = await loadState();
  let state = reducer(initialState(), {
    type: "QA_ASK",
    id: "q-pending",
    threadId: "thread-1",
    question: "What changed?",
  });
  state = reducer(state, { type: "QA_CANCEL_PENDING" });
  assert.equal(state.qa.items[0].status, "error");
  assert.match(state.qa.items[0].error, /navigation/);
});

test("follow-ups keep stable ids, full transcript, anchors, and resolved state", async () => {
  const { initialState, reducer } = await loadState();
  let state = reducer(initialState(), {
    type: "FOLLOWUP_ADD",
    id: "f-stable",
    text: "Rename this helper",
    transcript: "Rename this helper because it owns retries",
    anchor: { file: "src/retry.js", line: 8 },
    at: 2,
  });
  state = reducer(state, { type: "FOLLOWUP_TOGGLE", id: "f-stable" });
  assert.equal(state.followups[0].id, "f-stable");
  assert.equal(state.followups[0].transcript, "Rename this helper because it owns retries");
  assert.equal(state.followups[0].anchor.line, 8);
  assert.equal(state.followups[0].resolved, true);
});

test("routing results are applied one item at a time only after batch state opens", async () => {
  const { initialState, reducer } = await loadState();
  let state = reducer(initialState(), {
    type: "FOLLOWUP_ADD",
    id: "a",
    text: "Open issue A",
  });
  state = reducer(state, {
    type: "FOLLOWUP_ADD",
    id: "b",
    text: "Keep B",
  });
  state = reducer(state, { type: "ROUTING_OPEN" });
  state = reducer(state, { type: "ROUTING_SET", id: "a", route: "issue" });
  state = reducer(state, {
    type: "ROUTING_RESULTS",
    results: [{ id: "a", status: "created", issueUrl: "https://github.com/o/r/issues/7", issueNumber: 7 }],
    slackCopied: true,
  });
  assert.equal(state.followups[0].status, "created");
  assert.equal(state.followups[0].issueNumber, 7);
  assert.equal(state.followups[1].status, "note");
});

test("clear resets the PR session including the restored screen", async () => {
  const { reducer } = await loadState();
  const state = reducer(
    { screen: "followups", qa: { threadId: "t", items: [{ id: "q" }] }, followups: [{ id: "f" }] },
    { type: "CLEAR_SESSION" }
  );
  assert.equal(state.screen, "home");
  assert.deepEqual(plain(state.qa.items), []);
  assert.deepEqual(plain(state.followups), []);
});
