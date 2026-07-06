import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { refreshClaudeAuth } from "./lib/orchestrator.js";

test("refreshClaudeAuth skips when disabled", async () => {
  const dockerCalls = [];
  const result = await refreshClaudeAuth(() => {}, {
    env: { VOICE_PR_CLAUDE_AUTH_REFRESH: "never" },
    dx: async (args) => {
      dockerCalls.push(args);
      return { code: 0 };
    },
    run: async () => {
      throw new Error("security should not run");
    },
  });

  assert.deepEqual(result, { refreshed: false, reason: "disabled" });
  assert.deepEqual(dockerCalls, []);
});

test("refreshClaudeAuth skips when container has an Anthropic API key", async () => {
  const dockerCalls = [];
  const result = await refreshClaudeAuth(() => {}, {
    env: {},
    dx: async (args) => {
      dockerCalls.push(args);
      return { code: 0 };
    },
    run: async () => {
      throw new Error("security should not run");
    },
  });

  assert.deepEqual(result, { refreshed: false, reason: "api-key" });
  assert.deepEqual(dockerCalls, [["sh", "-lc", 'test -n "${ANTHROPIC_API_KEY:-}"']]);
});

test("refreshClaudeAuth writes keychain credentials and restarts mayor", async () => {
  const home = await mkdtemp(join(tmpdir(), "voice-pr-auth-"));
  const dockerCalls = [];
  const events = [];

  try {
    const result = await refreshClaudeAuth((stage, detail) => events.push({ stage, detail }), {
      env: {},
      homeDir: home,
      dx: async (args, opts = {}) => {
        dockerCalls.push({ args, opts });
        return args[0] === "sh" ? { code: 1 } : { code: 0 };
      },
      run: async (cmd, args) => {
        assert.equal(cmd, "security");
        assert.deepEqual(args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        return { stdout: '{"claude":"credential"}' };
      },
    });

    const file = join(home, ".codingagent", "secrets", "claude-credentials.json");
    assert.deepEqual(result, { refreshed: true, file });
    assert.equal(await readFile(file, "utf8"), '{"claude":"credential"}\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(dockerCalls, [
      {
        args: ["sh", "-lc", 'test -n "${ANTHROPIC_API_KEY:-}"'],
        opts: { allowFail: true },
      },
      {
        args: ["pogo", "agent", "stop", "mayor"],
        opts: { allowFail: true },
      },
    ]);
    assert.equal(events.at(-1).detail.line, "refreshed Claude OAuth credentials and restarted mayor");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("refreshClaudeAuth fails fast when keychain lookup fails", async () => {
  await assert.rejects(
    refreshClaudeAuth(() => {}, {
      env: {},
      dx: async (args) => (args[0] === "sh" ? { code: 1 } : { code: 0 }),
      run: async () => {
        throw new Error("`security find-generic-password` exited 44\nnot found");
      },
    }),
    /could not refresh Claude OAuth credentials from macOS keychain service "Claude Code-credentials"/
  );
});
