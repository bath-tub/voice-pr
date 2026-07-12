import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssue,
  findIssueByMarker,
  parsePr,
  repoSlug,
} from "../lib/github.js";

// parsePr is the very first thing every request does with user input; a silent
// change here mis-routes the whole session to the wrong repo/PR.
test("parsePr accepts a full github.com pull URL", () => {
  assert.deepEqual(parsePr("https://github.com/bath/voice-pr/pull/42"), {
    owner: "bath",
    repo: "voice-pr",
    number: 42,
  });
});

test("parsePr accepts a scheme-less github.com URL", () => {
  assert.deepEqual(parsePr("github.com/o/r/pull/7"), { owner: "o", repo: "r", number: 7 });
});

test("parsePr accepts the owner/repo#N shorthand", () => {
  assert.deepEqual(parsePr("bath/voice-pr#5"), { owner: "bath", repo: "voice-pr", number: 5 });
});

test("parsePr accepts the owner/repo/N shorthand", () => {
  assert.deepEqual(parsePr("bath/voice-pr/9"), { owner: "bath", repo: "voice-pr", number: 9 });
});

test("parsePr trims surrounding whitespace before matching", () => {
  assert.deepEqual(parsePr("  https://github.com/o/r/pull/3  "), { owner: "o", repo: "r", number: 3 });
});

test("parsePr coerces the PR number to an integer, never a string", () => {
  const pr = parsePr("o/r#11");
  assert.strictEqual(pr.number, 11);
  assert.equal(typeof pr.number, "number");
});

test("parsePr throws a helpful error on empty or unparseable input", () => {
  assert.throws(() => parsePr(""), /no PR reference/i);
  assert.throws(() => parsePr(undefined), /no PR reference/i);
  assert.throws(() => parsePr("not a pr"), /could not parse PR reference/i);
  assert.throws(() => parsePr("https://github.com/o/r/issues/3"), /could not parse/i);
});

test("repoSlug renders owner/repo", () => {
  assert.equal(repoSlug({ owner: "bath", repo: "voice-pr" }), "bath/voice-pr");
});

test("findIssueByMarker paginates all issues and scans exact body markers", async () => {
  const marker = `<!-- voice-pr-followup:${"a".repeat(64)} -->`;
  let call;
  const issue = await findIssueByMarker(
    { owner: "bath", repo: "voice-pr" },
    marker,
    {
      runCommand: async (cmd, args) => {
        call = { cmd, args };
        return {
          stdout: JSON.stringify([
            [
              {
                number: 8,
                html_url: "https://github.com/bath/voice-pr/issues/8",
                title: "Different follow-up",
                body: "no matching marker",
              },
            ],
            [
              {
                number: 9,
                html_url: "https://github.com/bath/voice-pr/issues/9",
                title: "Follow up",
                body: `details\n${marker}`,
              },
            ],
          ]),
        };
      },
    }
  );
  assert.equal(call.cmd, "gh");
  assert.ok(call.args.includes("repos/bath/voice-pr/issues"));
  assert.ok(call.args.includes("--paginate"));
  assert.ok(call.args.includes("--slurp"));
  assert.ok(call.args.includes("state=all"));
  assert.ok(call.args.includes("per_page=100"));
  assert.ok(!call.args.includes("search/issues"));
  assert.equal(issue.number, 9);
});

test("createIssue targets the PR repository and returns a compact issue", async () => {
  let call;
  const issue = await createIssue(
    { owner: "bath", repo: "voice-pr" },
    { title: "Follow up", body: "Details" },
    {
      runCommand: async (cmd, args) => {
        call = { cmd, args };
        return {
          stdout: JSON.stringify({
            number: 11,
            html_url: "https://github.com/bath/voice-pr/issues/11",
            title: "Follow up",
          }),
        };
      },
    }
  );
  assert.ok(call.args.includes("repos/bath/voice-pr/issues"));
  assert.ok(call.args.includes("title=Follow up"));
  assert.equal(issue.url, "https://github.com/bath/voice-pr/issues/11");
});
