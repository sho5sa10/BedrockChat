import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { CodeSessionManager, MAX_EVENTS_PER_SESSION } from "../code-agent/sessions.js";
import { ClaudeCodeAdapter } from "../code-agent/claude-code.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");
const FIXTURE_ECHO_RESUME = path.join(FIXTURES, "claude-echo-resume.js");

function makeInsideRoots(roots) {
  return (target) => {
    const abs = path.resolve(target);
    return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  };
}

function tmpDir(prefix = "claude-desk-sess-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

/** Scripted adapter: records every execute() call so tests can assert on resumeSessionId. */
class RecordingStubAdapter {
  constructor(eventsFactory, delayMs = 5) {
    this.eventsFactory = eventsFactory; // (callIndex, request) => events[]
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
    const events = this.eventsFactory(this.calls.length - 1, request);
    (async () => {
      for (const evt of events) {
        await new Promise((r) => setTimeout(r, this.delayMs));
        if (state.cancelled) return;
        emitter.emit("event", evt);
      }
    })();
    return emitter;
  }
}

describe("CodeSessionManager.createSession — validation & security", () => {
  test("rejects when no roots are registered", () => {
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([]) });
    const res = mgr.createSession({ repoPath: "C:\\x", prompt: "hi" }, []);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test("rejects invalid payload", () => {
    const allowed = tmpDir();
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]) });
    const res = mgr.createSession({ repoPath: "", prompt: "" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });

  test("rejects a repoPath outside the allowed roots", () => {
    const allowed = tmpDir();
    const outside = tmpDir();
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]) });
    const res = mgr.createSession({ repoPath: outside, prompt: "hi" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test("rejects a repoPath that does not exist", () => {
    const allowed = tmpDir();
    const missing = path.join(allowed, "nope");
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]) });
    const res = mgr.createSession({ repoPath: missing, prompt: "hi" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });
});

describe("CodeSessionManager — lifecycle & multi-turn", () => {
  test("createSession returns 202/starting immediately, with turnStartIndex 0", () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter(() => [{ type: "completed", summary: "done" }], 10_000);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const res = mgr.createSession({ repoPath: allowed, prompt: "hello", mode: "plan" }, [allowed]);
    assert.equal(res.ok, true);
    assert.equal(res.status, 202);
    assert.equal(res.session.status, "starting");
    assert.equal(res.session.turnStartIndex, 0);
  });

  test("progresses starting -> running -> ready, and a second turn resumes the first turn's session id", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter((callIndex) => [
      { type: "started", sessionId: callIndex === 0 ? "claude-sess-abc" : "should-not-be-used" },
      { type: "text", text: `turn ${callIndex}` },
      { type: "completed", summary: `done ${callIndex}` },
    ], 5);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });

    const createRes = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);
    const { sessionId } = createRes.session;
    assert.equal(mgr.getSession(sessionId).status, "running");
    await waitFor(() => mgr.getSession(sessionId).status === "ready");
    assert.equal(mgr.getSession(sessionId).claudeSessionId, "claude-sess-abc");

    const msgRes = mgr.sendMessage(sessionId, "second");
    assert.equal(msgRes.ok, true);
    assert.equal(msgRes.session.turnStartIndex, 3); // 3 events recorded from turn 1
    await waitFor(() => mgr.getSession(sessionId).status === "ready" && adapter.calls.length === 2);

    assert.equal(adapter.calls[0].resumeSessionId, undefined); // first turn: nothing to resume
    assert.equal(adapter.calls[1].resumeSessionId, "claude-sess-abc"); // second turn resumes it
    assert.equal(mgr.getSession(sessionId).events.length, 6); // both turns accumulated
  });

  test("rejects sendMessage while a turn is still busy (409)", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter(() => [
      { type: "started", sessionId: "s1" },
      { type: "completed", summary: "done" },
    ], 50);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);

    const res = mgr.sendMessage(session.sessionId, "too soon");
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);

    await waitFor(() => mgr.getSession(session.sessionId).status === "ready");
  });

  test("sendMessage validates prompt and unknown session id", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter(() => [{ type: "completed", summary: "done" }], 5);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready");

    assert.equal(mgr.sendMessage("cs_does_not_exist", "hi").status, 404);
    assert.equal(mgr.sendMessage(session.sessionId, "   ").status, 400);
  });

  test("a turn error sets status=failed but the session accepts further messages (not a dead end)", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter((callIndex) =>
      callIndex === 0
        ? [{ type: "error", code: "execution_error", message: "boom" }]
        : [{ type: "started", sessionId: "s2" }, { type: "completed", summary: "recovered" }]
    , 5);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(session.sessionId).status === "failed");
    assert.match(mgr.getSession(session.sessionId).error, /boom/);

    const retry = mgr.sendMessage(session.sessionId, "try again");
    assert.equal(retry.ok, true);
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready");
    assert.equal(mgr.getSession(session.sessionId).error, null);
  });

  test("getSession returns null for unknown ids", () => {
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([]) });
    assert.equal(mgr.getSession("cs_nope"), null);
  });
});

describe("CodeSessionManager.cancelTurn", () => {
  test("cancels an in-flight turn: status becomes cancelled, and the session still accepts new messages", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter((callIndex) =>
      callIndex === 0
        ? [{ type: "started", sessionId: "s1" }, { type: "text", text: "still going" }, { type: "completed", summary: "should not arrive" }]
        : [{ type: "started", sessionId: "s1" }, { type: "completed", summary: "second turn ok" }]
    , 40);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);

    await waitFor(() => mgr.getSession(session.sessionId).status === "running");
    const cancelRes = mgr.cancelTurn(session.sessionId);
    assert.equal(cancelRes.ok, true);

    await waitFor(() => mgr.getSession(session.sessionId).status === "cancelled");
    const record = mgr.getSession(session.sessionId);
    assert.equal(record.busy, false);
    assert.equal(record.events.at(-1).type, "cancelled");
    assert.ok(!record.events.some((e) => e.summary === "should not arrive"));

    const retry = mgr.sendMessage(session.sessionId, "keep going");
    assert.equal(retry.ok, true);
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready");
  });

  test("rejects cancelling an unknown session (404) or one that isn't running (409)", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter(() => [{ type: "completed", summary: "done" }], 5);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });

    assert.equal(mgr.cancelTurn("cs_does_not_exist").status, 404);

    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready");
    assert.equal(mgr.cancelTurn(session.sessionId).status, 409); // nothing running anymore
  });
});

describe("CodeSessionManager.subscribe — live events per turn", () => {
  test("a subscriber receives events across multiple turns of the same session", async () => {
    const allowed = tmpDir();
    const adapter = new RecordingStubAdapter((callIndex) => [
      { type: "started", sessionId: "s1" },
      { type: "text", text: `t${callIndex}` },
      { type: "completed", summary: "ok" },
    ], 5);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);

    const seen = [];
    const onEvent = (evt) => seen.push(evt.type);
    mgr.subscribe(session.sessionId, onEvent);

    await waitFor(() => mgr.getSession(session.sessionId).status === "ready");
    mgr.sendMessage(session.sessionId, "second");
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready" && adapter.calls.length === 2);
    mgr.unsubscribe(session.sessionId, onEvent);

    assert.deepEqual(seen, ["started", "text", "completed", "started", "text", "completed"]);
  });
});

describe("CodeSessionManager — event log trimming keeps reconnects aligned", () => {
  test("turnStartIndex still points at the current turn's first event after the log hits its cap", async () => {
    // Regression test for the "long session loses part of the latest reply on
    // browser refresh" bug: a reconnecting client replays record.events and
    // skips exactly turnStartIndex of them (see GET .../events). Once the log
    // is full, every push shifts the front of the array — so turnStartIndex
    // has to shift with it, or the client skips *into* the live turn and
    // silently drops the beginning of the answer it is waiting for.
    const allowed = tmpDir();
    const firstTurnEvents = [
      { type: "started", sessionId: "s1" },
      ...Array.from({ length: MAX_EVENTS_PER_SESSION - 2 }, (_, i) => ({ type: "text", text: `chatter ${i}` })),
      { type: "completed", summary: "long turn done" },
    ];
    const secondTurnEvents = [
      { type: "started", sessionId: "s1" },
      { type: "text", text: "the reply the user is actually waiting for" },
      { type: "completed", summary: "second turn done" },
    ];
    const adapter = new RecordingStubAdapter((callIndex) => (callIndex === 0 ? firstTurnEvents : secondTurnEvents), 0);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });

    const { session } = mgr.createSession({ repoPath: allowed, prompt: "first", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready", { timeoutMs: 30_000 });
    const record = mgr.getSession(session.sessionId);
    assert.equal(record.events.length, MAX_EVENTS_PER_SESSION); // full, but not yet trimmed

    mgr.sendMessage(session.sessionId, "second");
    await waitFor(() => mgr.getSession(session.sessionId).status === "ready" && adapter.calls.length === 2);

    assert.equal(record.events.length, MAX_EVENTS_PER_SESSION); // capped: three oldest events were dropped
    const replayed = record.events.slice(record.turnStartIndex);
    assert.deepEqual(
      replayed.map((e) => e.type),
      ["started", "text", "completed"]
    );
    assert.match(replayed[1].text, /actually waiting for/);
  });
});

describe("ClaudeCodeAdapter — resumeSessionId argv (real subprocess)", () => {
  test("passes --resume <id> only when resumeSessionId is set, verified via a fixture that echoes it back", async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath, extraArgs: [FIXTURE_ECHO_RESUME] });

    const first = await collectUntilTerminal(adapter.execute({ repoPath: __dirname, prompt: "hi", mode: "plan" }));
    const firstText = first.find((e) => e.type === "text").text;
    assert.equal(firstText, "echo:hi");

    const second = await collectUntilTerminal(
      adapter.execute({ repoPath: __dirname, prompt: "again", mode: "plan", resumeSessionId: "abc-123" })
    );
    const secondText = second.find((e) => e.type === "text").text;
    assert.equal(secondText, "echo:again (resumed:abc-123)");
  });
});

function collectUntilTerminal(run, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error("collectUntilTerminal: timed out")), timeoutMs);
    run.on("event", (evt) => {
      events.push(evt);
      if (evt.type === "completed" || evt.type === "error") {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });
}
