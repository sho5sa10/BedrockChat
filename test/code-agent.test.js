import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateCodeAgentRequest, MODES, MAX_PROMPT_BYTES } from "../code-agent/contract.js";
import { CodeAgent } from "../code-agent/index.js";
import { ClaudeCodeAdapter } from "../code-agent/claude-code.js";
import { isGitRepo, captureGitStatus, captureGitDiffStat } from "../code-agent/git-info.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");
const FIXTURE_SUCCESS = path.join(FIXTURES, "claude-stream-success.js");
const FIXTURE_ERROR_RESULT = path.join(FIXTURES, "claude-stream-error-result.js");
const FIXTURE_CRASH = path.join(FIXTURES, "claude-crash-no-result.js");
const FIXTURE_SLOW = path.join(FIXTURES, "claude-stream-slow.js");

function makeInsideRoots(roots) {
  return (target) => {
    const abs = path.resolve(target);
    return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  };
}

function tmpDir(prefix = "bedrockchat-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

/** Emits scripted normalized events on a delay, like a real background run would. */
class StagedStubAdapter {
  constructor(events, delayMs = 5) {
    this.events = events;
    this.delayMs = delayMs;
    this.calls = [];
  }
  execute(request) {
    this.calls.push(request);
    const emitter = new EventEmitter();
    const state = { cancelled: false };
    emitter.cancel = () => {
      if (state.cancelled) return;
      state.cancelled = true;
      emitter.emit("event", { type: "cancelled" });
    };
    (async () => {
      for (const evt of this.events) {
        await new Promise((r) => setTimeout(r, this.delayMs));
        if (state.cancelled) return;
        emitter.emit("event", evt);
      }
    })();
    return emitter;
  }
}

describe("contract: validateCodeAgentRequest", () => {
  test("accepts a minimal valid request", () => {
    assert.deepEqual(validateCodeAgentRequest({ repoPath: "C:\\work\\repo", prompt: "do the thing", mode: "plan" }), []);
  });
  test("rejects a missing repoPath", () => {
    assert.ok(validateCodeAgentRequest({ prompt: "x", mode: "plan" }).some((e) => /repoPath/.test(e)));
  });
  test("rejects a missing prompt", () => {
    assert.ok(validateCodeAgentRequest({ repoPath: "C:\\work\\repo", mode: "plan" }).some((e) => /prompt/.test(e)));
  });
  test("rejects an empty prompt", () => {
    assert.ok(validateCodeAgentRequest({ repoPath: "C:\\work\\repo", prompt: "   ", mode: "plan" }).some((e) => /prompt/.test(e)));
  });
  test("rejects a prompt over the byte limit", () => {
    const errors = validateCodeAgentRequest({ repoPath: "C:\\work\\repo", prompt: "a".repeat(MAX_PROMPT_BYTES + 1), mode: "plan" });
    assert.ok(errors.some((e) => /bytes/.test(e)));
  });
  test("rejects an unknown mode", () => {
    assert.ok(validateCodeAgentRequest({ repoPath: "C:\\work\\repo", prompt: "x", mode: "yolo" }).some((e) => /mode/.test(e)));
  });
  test("accepts every declared mode", () => {
    for (const mode of MODES) assert.deepEqual(validateCodeAgentRequest({ repoPath: "r", prompt: "x", mode }), []);
  });
  test("rejects non-array allowedTools", () => {
    assert.ok(validateCodeAgentRequest({ repoPath: "r", prompt: "x", allowedTools: "Bash" }).some((e) => /allowedTools/.test(e)));
  });
});

describe("CodeAgent.listRepos", () => {
  test("returns an empty list when no roots are registered", () => {
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([]) });
    assert.deepEqual(agent.listRepos([]), []);
  });
  test("maps multiple roots to {path, name}", () => {
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([]) });
    const roots = ["C:\\work\\BedrockChat", "C:\\work\\terraform-genesys_cloud"];
    assert.deepEqual(agent.listRepos(roots), [
      { path: "C:\\work\\BedrockChat", name: "BedrockChat" },
      { path: "C:\\work\\terraform-genesys_cloud", name: "terraform-genesys_cloud" },
    ]);
  });
});

describe("CodeAgent.createRequest — validation & security (all synchronous, before any adapter call)", () => {
  test("rejects when no roots are registered at all", () => {
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([]), adapter: new StagedStubAdapter([]) });
    const res = agent.createRequest({ repoPath: "C:\\anything", prompt: "x", mode: "plan" }, []);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test("rejects invalid payload before touching the filesystem", () => {
    const agent = new CodeAgent({ insideRoots: makeInsideRoots(["C:\\work"]), adapter: new StagedStubAdapter([]) });
    const res = agent.createRequest({ repoPath: "", prompt: "", mode: "bogus" }, ["C:\\work"]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.ok(res.errors.length >= 2);
  });

  test("rejects a repoPath outside the allowed roots", () => {
    const allowed = tmpDir("allowed-");
    const outside = tmpDir("outside-");
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter: new StagedStubAdapter([]) });
    const res = agent.createRequest({ repoPath: outside, prompt: "x", mode: "plan" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test("rejects a path-traversal attempt (../) that resolves outside the root", () => {
    const allowed = tmpDir("allowed-");
    const escaped = path.join(allowed, "..", "escaped-" + path.basename(allowed));
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter: new StagedStubAdapter([]) });
    const res = agent.createRequest({ repoPath: escaped, prompt: "x", mode: "plan" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test("rejects a repoPath that does not exist on disk", () => {
    const allowed = tmpDir("allowed-");
    const missing = path.join(allowed, "does-not-exist");
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter: new StagedStubAdapter([]) });
    const res = agent.createRequest({ repoPath: missing, prompt: "x", mode: "plan" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });
});

describe("CodeAgent.createRequest — async lifecycle", () => {
  test("returns 202/accepted immediately, without waiting on the adapter", () => {
    const allowed = tmpDir("allowed-");
    // A slow stub — if createRequest waited on it, this test would time out.
    const adapter = new StagedStubAdapter([{ type: "completed", summary: "done" }], 10_000);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "実装してください" }, [allowed]);
    assert.equal(res.ok, true);
    assert.equal(res.status, 202);
    assert.equal(res.request.status, "accepted");
    assert.equal(adapter.calls[0].mode, "plan"); // default mode applied
  });

  test("progresses accepted -> starting -> running -> completed as events arrive", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([
      { type: "started", sessionId: "s1" },
      { type: "text", text: "working on it" },
      { type: "completed", summary: "all done", durationMs: 42, costUsd: 0.001 },
    ], 5);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "plan" }, [allowed]);

    // The HTTP response itself reports "accepted" (previous test); the record
    // moves on to "starting" synchronously as launch begins.
    assert.equal(agent.getRequest(res.request.requestId).status, "starting");
    await waitFor(() => agent.getRequest(res.request.requestId).status === "running");
    await waitFor(() => agent.getRequest(res.request.requestId).status === "completed");

    const record = agent.getRequest(res.request.requestId);
    assert.equal(record.summary, "all done");
    assert.equal(record.durationMs, 42);
    assert.equal(record.startedAt !== null, true);
    assert.equal(record.events.map((e) => e.type).join(","), "started,text,completed");
    // repoPath here is a plain tmp dir, not a git repo — capture must degrade gracefully.
    assert.equal(record.git.before, null);
    assert.equal(record.git.after, null);
  });

  test("transitions to failed and records the error when the adapter reports one", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([
      { type: "started", sessionId: "s1" },
      { type: "error", code: "execution_error", message: "boom" },
    ], 5);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "acceptEdits" }, [allowed]);

    await waitFor(() => agent.getRequest(res.request.requestId).status === "failed");
    const record = agent.getRequest(res.request.requestId);
    assert.match(record.error, /boom/);
  });

  test("a cli_not_found error (no preceding 'started') still resolves the request as failed", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([{ type: "error", code: "cli_not_found", message: "not found" }], 5);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "plan" }, [allowed]);
    await waitFor(() => agent.getRequest(res.request.requestId).status === "failed");
    assert.equal(agent.getRequest(res.request.requestId).startedAt, null);
  });

  test("getRequest returns null for unknown ids", () => {
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([]) });
    assert.equal(agent.getRequest("cr_does_not_exist"), null);
  });
});

describe("CodeAgent.cancelRequest", () => {
  test("cancels a running request: status becomes cancelled", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([
      { type: "started", sessionId: "s1" },
      { type: "completed", summary: "should not arrive" },
    ], 40);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "plan" }, [allowed]);

    await waitFor(() => agent.getRequest(res.request.requestId).status === "running");
    const cancelRes = agent.cancelRequest(res.request.requestId);
    assert.equal(cancelRes.ok, true);

    await waitFor(() => agent.getRequest(res.request.requestId).status === "cancelled");
    const record = agent.getRequest(res.request.requestId);
    assert.equal(record.events.at(-1).type, "cancelled");
    assert.ok(!record.events.some((e) => e.summary === "should not arrive"));
  });

  test("rejects cancelling an unknown request (404) or one that already finished (409)", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([{ type: "completed", summary: "done" }], 5);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });

    assert.equal(agent.cancelRequest("cr_does_not_exist").status, 404);

    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "plan" }, [allowed]);
    await waitFor(() => agent.getRequest(res.request.requestId).status === "completed");
    assert.equal(agent.cancelRequest(res.request.requestId).status, 409);
  });
});

describe("CodeAgent.subscribe — SSE-style replay + live tail", () => {
  test("a subscriber attached mid-run receives subsequent events, and history is available separately for replay", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([
      { type: "started", sessionId: "s1" },
      { type: "tool", tool: "Read", target: "a.js" },
      { type: "text", text: "hi" },
      { type: "completed", summary: "done" },
    ], 15);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "plan" }, [allowed]);

    const live = [];
    const onEvent = (evt) => live.push(evt.type);
    agent.subscribe(res.request.requestId, onEvent);

    await waitFor(() => agent.getRequest(res.request.requestId).status === "completed");
    agent.unsubscribe(res.request.requestId, onEvent);

    assert.deepEqual(live, ["started", "tool", "text", "completed"]);
    // A reconnecting client would replay from record.events — same sequence.
    assert.deepEqual(agent.getRequest(res.request.requestId).events.map((e) => e.type), live);
  });

  test("unsubscribe stops further delivery", async () => {
    const allowed = tmpDir("allowed-");
    const adapter = new StagedStubAdapter([
      { type: "started", sessionId: "s1" },
      { type: "completed", summary: "done" },
    ], 10);
    const agent = new CodeAgent({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = agent.createRequest({ repoPath: allowed, prompt: "x", mode: "plan" }, [allowed]);

    const live = [];
    const onEvent = (evt) => live.push(evt.type);
    agent.subscribe(res.request.requestId, onEvent);
    await waitFor(() => agent.getRequest(res.request.requestId).status === "running");
    agent.unsubscribe(res.request.requestId, onEvent);
    await waitFor(() => agent.getRequest(res.request.requestId).status === "completed");

    assert.deepEqual(live, ["started"]); // "completed" arrived after unsubscribe
  });
});

describe("git-info (read-only helpers — never mutate the repo)", () => {
  test("degrades to null for a non-git directory", () => {
    const dir = tmpDir("nogit-");
    assert.equal(isGitRepo(dir), false);
    assert.equal(captureGitStatus(dir), null);
    assert.equal(captureGitDiffStat(dir), null);
  });

  test("captureGitDiffStat reports changed files after a real edit", () => {
    const dir = tmpDir("git-");
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "init"], dir);

    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");

    assert.equal(isGitRepo(dir), true);
    const diff = captureGitDiffStat(dir);
    assert.deepEqual(diff.changedFiles, ["a.txt"]);
    assert.match(diff.shortStat, /1 file changed/);
  });
});

describe("ClaudeCodeAdapter — real stream-json parsing against fixture CLIs", () => {
  test("normalizes a successful run into started -> text/tool -> completed", async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath, extraArgs: [FIXTURE_SUCCESS] });
    const run = adapter.execute({ repoPath: __dirname, prompt: "hello", mode: "plan" });
    const events = await collectUntilTerminal(run);

    assert.equal(events[0].type, "started");
    assert.equal(events[0].sessionId, "sess-success-1");
    assert.ok(events.some((e) => e.type === "text" && /Investigating/.test(e.text)));
    assert.ok(events.some((e) => e.type === "tool" && e.tool === "Read" && e.target === "src/foo.js"));
    const last = events.at(-1);
    assert.equal(last.type, "completed");
    assert.match(last.summary, /helper function/);
    assert.equal(last.durationMs, 1234);
    assert.deepEqual(last.usage, { inputTokens: 120, outputTokens: 340, cacheReadTokens: 500, cacheCreationTokens: 0 });
  });

  test("normalizes a structured CLI failure (result.is_error=true) into an error event", async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath, extraArgs: [FIXTURE_ERROR_RESULT] });
    const run = adapter.execute({ repoPath: __dirname, prompt: "hello", mode: "plan" });
    const events = await collectUntilTerminal(run);
    const last = events.at(-1);
    assert.equal(last.type, "error");
    assert.match(last.message, /something went wrong/);
  });

  test("synthesizes an error when the process exits without ever emitting a result line", async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath, extraArgs: [FIXTURE_CRASH] });
    const run = adapter.execute({ repoPath: __dirname, prompt: "hello", mode: "plan" });
    const events = await collectUntilTerminal(run);
    const last = events.at(-1);
    assert.equal(last.type, "error");
    assert.equal(last.code, "execution_error");
    assert.match(last.message, /crashed/);
  });

  test("cancel() kills the running process and emits a cancelled terminal event", async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath, extraArgs: [FIXTURE_SLOW] });
    const run = adapter.execute({ repoPath: __dirname, prompt: "hello", mode: "plan" });

    // Wait for "started" so we know the process is actually up before cancelling it.
    await new Promise((resolve) => {
      run.on("event", function onEvt(evt) {
        if (evt.type === "started") { run.off("event", onEvt); resolve(); }
      });
    });
    run.cancel();

    const events = await collectUntilTerminal(run, 5000);
    assert.equal(events.at(-1).type, "cancelled");
  });

  test("cancel() called before the process ever spawns still resolves cleanly to cancelled", async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath, extraArgs: [FIXTURE_SLOW] });
    const run = adapter.execute({ repoPath: __dirname, prompt: "hello", mode: "plan" });
    run.cancel(); // fires before the deferred #run() has even started (execute() defers via setImmediate)

    const events = await collectUntilTerminal(run, 5000);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "cancelled");
  });

  test("emits a cli_not_found error immediately when the binary does not exist, without spawning", async () => {
    const adapter = new ClaudeCodeAdapter({ command: "definitely-not-a-real-claude-binary-xyz-12345" });
    const run = adapter.execute({ repoPath: __dirname, prompt: "hello", mode: "plan" });
    const events = await collectUntilTerminal(run);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].code, "cli_not_found");
  });
});

/** Collects normalized events off an adapter run until the terminal (completed/error) event. */
function collectUntilTerminal(run, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error("collectUntilTerminal: timed out")), timeoutMs);
    run.on("event", (evt) => {
      events.push(evt);
      if (evt.type === "completed" || evt.type === "error" || evt.type === "cancelled") {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });
}
