import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verificationCommands,
  verifyAndPushAgentCommits,
} from "../lib/pipeline.js";

test("VOICE_PR_VERIFY_CMD overrides repo-local scripts", async () => {
  await withTempCheckout(async (checkout) => {
    await writeFile(join(checkout, "build.sh"), "exit 0\n");
    await writeFile(join(checkout, "test.sh"), "exit 0\n");

    const commands = await verificationCommands(checkout, {
      VOICE_PR_VERIFY_CMD: "npm run verify",
    });

    assert.deepEqual(commands, [
      { label: "VOICE_PR_VERIFY_CMD", shell: "npm run verify" },
    ]);
  });
});

test("repo-local build.sh and test.sh are selected in build-then-test order", async () => {
  await withTempCheckout(async (checkout) => {
    await writeFile(join(checkout, "test.sh"), "exit 0\n");
    await writeFile(join(checkout, "build.sh"), "exit 0\n");

    const commands = await verificationCommands(checkout, {});

    assert.deepEqual(commands, [
      { label: "./build.sh", shell: "bash ./build.sh" },
      { label: "./test.sh", shell: "bash ./test.sh" },
    ]);
  });
});

test("missing verification command fails before push", async () => {
  await withTempCheckout(async (checkout) => {
    await assert.rejects(
      () => verificationCommands(checkout, {}),
      /no verification command found before push/
    );
  });
});

test("failed verification prevents git push", async () => {
  await withTempCheckout(async (checkout) => {
    const calls = [];
    const runner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      if (cmd === "bash") throw new Error("tests failed");
      return { code: 0, stdout: "", stderr: "" };
    };

    await assert.rejects(
      () =>
        verifyAndPushAgentCommits({
          checkout,
          branch: "agent-branch",
          committed: [{ title: "change" }],
          env: { VOICE_PR_VERIFY_CMD: "npm test" },
          runner,
        }),
      /verification failed before push \(VOICE_PR_VERIFY_CMD\): tests failed/
    );

    assert.deepEqual(calls, [
      { cmd: "bash", args: ["-lc", "npm test"], cwd: checkout },
    ]);
  });
});

test("successful verification pushes the agent branch", async () => {
  await withTempCheckout(async (checkout) => {
    const calls = [];
    const runner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { code: 0, stdout: "", stderr: "" };
    };

    const pushed = await verifyAndPushAgentCommits({
      checkout,
      branch: "agent-branch",
      committed: [{ title: "change" }],
      env: { VOICE_PR_VERIFY_CMD: "npm test" },
      runner,
    });

    assert.equal(pushed, true);
    assert.deepEqual(calls, [
      { cmd: "bash", args: ["-lc", "npm test"], cwd: checkout },
      { cmd: "git", args: ["push", "origin", "agent-branch"], cwd: checkout },
    ]);
  });
});

async function withTempCheckout(fn) {
  const dir = await mkdtemp(join(tmpdir(), "voice-pr-verify-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
