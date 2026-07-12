import assert from "node:assert/strict";
import test from "node:test";
import {
  createFollowupsService,
  deterministicIssueTitle,
  followupIssueBody,
  idempotencyMarker,
} from "../lib/followups.js";

const pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "Add retry",
  url: "https://github.com/o/r/pull/7",
};

const item = {
  clientItemId: "client-item-1",
  originalText: "Add a regression test for timeout retries",
  anchor: {
    file: "lib/net.js",
    line: 12,
    snippet: "return retry(request)",
  },
};

test("follow-up retries find the hidden marker and return the existing issue", async () => {
  const issues = [];
  let creates = 0;
  const service = createFollowupsService({
    resolvePr: async () => pr,
    findIssue: async (_pr, marker) =>
      issues.find((entry) => entry.body.includes(marker))?.issue || null,
    createIssue: async (_pr, input) => {
      creates++;
      const issue = {
        number: 42,
        url: "https://github.com/o/r/issues/42",
        title: input.title,
      };
      issues.push({ ...input, issue });
      return issue;
    },
  });

  const first = await service.createBatch({
    prRef: pr.url,
    confirmed: true,
    items: [item],
  });
  const retry = await service.createBatch({
    prRef: pr.url,
    confirmed: true,
    items: [item],
  });

  assert.equal(first.results[0].status, "created");
  assert.equal(retry.results[0].status, "existing");
  assert.equal(retry.results[0].issue.number, 42);
  assert.deepEqual(
    {
      id: retry.results[0].id,
      clientItemId: retry.results[0].clientItemId,
      issueUrl: retry.results[0].issueUrl,
      issueNumber: retry.results[0].issueNumber,
      error: retry.results[0].error,
    },
    {
      id: "client-item-1",
      clientItemId: "client-item-1",
      issueUrl: "https://github.com/o/r/issues/42",
      issueNumber: 42,
      error: null,
    }
  );
  assert.equal(creates, 1);
  assert.match(issues[0].body, /<!-- voice-pr-followup:[a-f0-9]{64} -->/);
});

test("idempotency markers are stable per PR and client item", () => {
  const first = idempotencyMarker(pr, "stable-id");
  assert.equal(first, idempotencyMarker(pr, "stable-id"));
  assert.notEqual(first, idempotencyMarker(pr, "different-id"));
  assert.notEqual(first, idempotencyMarker({ ...pr, number: 8 }, "stable-id"));
  assert.match(first, /^<!-- voice-pr-followup:[a-f0-9]{64} -->$/);
});

test("issue body preserves source PR, location, snippet, and original text", () => {
  const marker = idempotencyMarker(pr, item.clientItemId);
  const body = followupIssueBody(pr, item, marker);
  assert.match(body, /Add a regression test for timeout retries/);
  assert.match(body, /https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(body, /`lib\/net\.js:12`/);
  assert.match(body, /> return retry\(request\)/);
  assert.ok(body.endsWith(marker));
  assert.equal(
    deterministicIssueTitle(item, pr),
    "Follow up: Add a regression test for timeout retries"
  );
});

test("batch creation normalizes per-item failures and skipped items", async () => {
  let number = 100;
  const service = createFollowupsService({
    resolvePr: async () => pr,
    findIssue: async () => null,
    createIssue: async (_pr, input) => {
      if (input.body.includes("broken follow-up")) throw new Error("GitHub unavailable");
      return {
        number: number++,
        url: `https://github.com/o/r/issues/${number}`,
        title: input.title,
      };
    },
  });
  const result = await service.createBatch({
    prRef: pr.url,
    confirmed: true,
    items: [
      item,
      { ...item, clientItemId: "bad", originalText: "broken follow-up" },
      { ...item, clientItemId: "rejected", approved: false },
    ],
  });

  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["created", "error", "skipped"]
  );
  assert.match(result.results[1].error, /GitHub unavailable/);
  assert.deepEqual(result.results[1], {
    id: "bad",
    clientItemId: "bad",
    status: "error",
    issueUrl: null,
    issueNumber: null,
    error: "GitHub unavailable",
    issue: null,
  });
  assert.deepEqual(result.results[2], {
    id: "rejected",
    clientItemId: "rejected",
    status: "skipped",
    issueUrl: null,
    issueNumber: null,
    error: null,
    issue: null,
  });
});

test("partial retries remain idempotent across a fresh service process", async () => {
  const persistedIssues = [];
  let failBrokenOnce = true;
  let successfulCreates = 0;
  let createAttempts = 0;
  let nextNumber = 70;
  const good = { ...item, clientItemId: "good" };
  const broken = {
    ...item,
    clientItemId: "broken",
    originalText: "broken follow-up",
  };

  const makeService = () =>
    createFollowupsService({
      resolvePr: async () => pr,
      findIssue: async (_pr, marker) =>
        persistedIssues.find((entry) => entry.body.includes(marker))?.issue ||
        null,
      createIssue: async (_pr, input) => {
        createAttempts++;
        if (input.body.includes("broken follow-up") && failBrokenOnce) {
          failBrokenOnce = false;
          throw new Error("temporary GitHub failure");
        }
        const issue = {
          number: nextNumber++,
          url: `https://github.com/o/r/issues/${nextNumber - 1}`,
          title: input.title,
        };
        successfulCreates++;
        persistedIssues.push({ ...input, issue });
        return issue;
      },
    });

  const first = await makeService().createBatch({
    prRef: pr.url,
    confirmed: true,
    items: [good, broken],
  });
  assert.deepEqual(
    first.results.map((entry) => entry.status),
    ["created", "error"]
  );

  const retry = await makeService().createBatch({
    prRef: pr.url,
    confirmed: true,
    items: [good, broken],
  });
  assert.deepEqual(
    retry.results.map((entry) => entry.status),
    ["existing", "created"]
  );
  assert.equal(retry.results[0].issueNumber, first.results[0].issueNumber);
  assert.equal(retry.results[0].issueUrl, first.results[0].issueUrl);
  assert.equal(retry.results[1].id, "broken");
  assert.equal(retry.results[1].error, null);
  assert.equal(successfulCreates, 2, "only two GitHub issues were created");
  assert.equal(createAttempts, 3, "the failed attempt did not create an issue");
  assert.equal(persistedIssues.length, 2);
});

test("issue creation requires explicit confirmation before resolving the PR", async () => {
  let resolved = false;
  const service = createFollowupsService({
    resolvePr: async () => {
      resolved = true;
      return pr;
    },
  });
  await assert.rejects(
    service.createBatch({ prRef: pr.url, confirmed: false, items: [item] }),
    /explicit confirmation/
  );
  assert.equal(resolved, false);
});

test("oversized follow-ups fail without creating an issue", async () => {
  let created = false;
  const service = createFollowupsService({
    resolvePr: async () => pr,
    findIssue: async () => null,
    createIssue: async () => {
      created = true;
      return {};
    },
  });
  const result = await service.createBatch({
    prRef: pr.url,
    confirmed: true,
    items: [{ ...item, originalText: "x".repeat(10_001) }],
  });
  assert.equal(result.results[0].status, "error");
  assert.match(result.results[0].error, /exceeds 10000 characters/);
  assert.equal(created, false);
});
