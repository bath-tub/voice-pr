import assert from "node:assert/strict";
import test from "node:test";
import { createBranchQueue } from "../lib/branch-queue.js";

test("serializes dispatches for the same branch in enqueue order", async () => {
  const queue = createBranchQueue();
  const firstGate = deferred();
  const events = [];
  const queued = [];

  const first = queue.run("bath-tub/voice-pr:feature", async () => {
    events.push("first-start");
    await firstGate.promise;
    events.push("first-end");
    return "first";
  });
  await flushMicrotasks();

  const second = queue.run(
    "bath-tub/voice-pr:feature",
    async () => {
      events.push("second-start");
      events.push("second-end");
      return "second";
    },
    { onQueued: (detail) => queued.push(detail) }
  );
  const third = queue.run("bath-tub/voice-pr:feature", async () => {
    events.push("third-start");
    events.push("third-end");
    return "third";
  });
  await flushMicrotasks();

  assert.deepEqual(events, ["first-start"]);
  assert.deepEqual(queued, [{ key: "bath-tub/voice-pr:feature", position: 2 }]);

  firstGate.resolve();

  assert.deepEqual(await Promise.all([first, second, third]), [
    "first",
    "second",
    "third",
  ]);
  assert.deepEqual(events, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
    "third-start",
    "third-end",
  ]);
  assert.equal(queue.pending("bath-tub/voice-pr:feature"), 0);
});

test("runs dispatches for different branches concurrently", async () => {
  const queue = createBranchQueue();
  const branchAGate = deferred();
  const branchBGate = deferred();
  const events = [];

  const branchA = queue.run("bath-tub/voice-pr:feature-a", async () => {
    events.push("a-start");
    await branchAGate.promise;
    events.push("a-end");
    return "a";
  });
  const branchB = queue.run("bath-tub/voice-pr:feature-b", async () => {
    events.push("b-start");
    await branchBGate.promise;
    events.push("b-end");
    return "b";
  });
  await flushMicrotasks();

  assert.deepEqual(events, ["a-start", "b-start"]);

  branchBGate.resolve();
  assert.equal(await branchB, "b");
  assert.deepEqual(events, ["a-start", "b-start", "b-end"]);

  branchAGate.resolve();
  assert.equal(await branchA, "a");
  assert.deepEqual(events, ["a-start", "b-start", "b-end", "a-end"]);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
