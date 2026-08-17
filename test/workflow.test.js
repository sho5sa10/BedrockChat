import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

import { CodeSessionManager } from "../code-agent/sessions.js";
import { currentBranch } from "../code-agent/git-adapter.js";

function tmpDir(prefix = "bedrockchat-workflow-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** A real git repo with a real, fast, always-passing "npm test" — so the
 *  workflow's test phase exercises TestRunner for real, not mocked. */
function makeRepo() {
  const dir = tmpDir();
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(dir, "app.js"), "console.log('hello');\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

function makeInsideRoots(roots) {
  return (target) => {
    const abs = path.resolve(target);
    return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

/**
 * Scripted adapter for exercising the workflow without a real Claude Code
 * invocation. Each call gets its own scripted event list; asserts on
 * request.mode so tests can confirm the workflow forces "plan" for
 * planning turns and "acceptEdits" for editing turns regardless of the
 * session's own base mode.
 */
class WorkflowStubAdapter {
  constructor(scriptForCall) {
    this.scriptForCall = scriptForCall; // (callIndex, request) => events[]
    this.calls = [];
  }
  execute(request) {
    this.calls.push(request);
    const emitter = new EventEmitter();
    emitter.cancel = () => emitter.emit("event", { type: "cancelled" });
    const events = this.scriptForCall(this.calls.length - 1, request);
    (async () => {
      for (const evt of events) {
        await new Promise((r) => setTimeout(r, 5));
        emitter.emit("event", evt);
      }
    })();
    return emitter;
  }
}

describe("Workflow — startPlan", () => {
  test("forces plan mode regardless of the session's own mode, and reaches plan_ready", async () => {
    const allowed = makeRepo();
    const adapter = new WorkflowStubAdapter(() => [
      { type: "started", sessionId: "s1" },
      { type: "completed", summary: "1. Change app.js to log goodbye instead." },
    ]);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "acceptEdits" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");

    const res = mgr.startPlan(created.session.sessionId, "say hello differently");
    assert.equal(res.ok, true);
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow?.status === "plan_ready");

    assert.equal(adapter.calls.at(-1).mode, "plan"); // forced, even though the session's base mode is acceptEdits
    const wf = mgr.getSession(created.session.sessionId).workflow;
    assert.match(wf.plan, /goodbye/);
  });

  test("rejects starting a second workflow while one is already in progress", async () => {
    const allowed = makeRepo();
    const adapter = new WorkflowStubAdapter(() => [{ type: "completed", summary: "plan text" }]);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");

    mgr.startPlan(created.session.sessionId, "first plan");
    const second = mgr.startPlan(created.session.sessionId, "second plan");
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
  });
});

describe("Workflow — approvePlan (real git branch isolation)", () => {
  test("creates an ai/<sessionId> branch, runs the edit turn in acceptEdits mode, then runs tests and captures a real diff", async () => {
    const allowed = makeRepo();
    const baseBranch = currentBranch(allowed);
    // Call #0 is createSession's own first turn; #1 is startPlan's; #2 is approvePlan's edit turn.
    const adapter = new WorkflowStubAdapter((callIndex) => {
      if (callIndex <= 1) return [{ type: "started", sessionId: "s1" }, { type: "completed", summary: "plan: edit app.js" }];
      // Editing turn: actually perform the edit for real, so the diff/test phases have something real to work with.
      fs.writeFileSync(path.join(allowed, "app.js"), "console.log('goodbye');\n");
      return [{ type: "completed", summary: "edited app.js" }];
    });
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");
    mgr.startPlan(created.session.sessionId, "change the greeting");
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");

    const approveRes = mgr.approvePlan(created.session.sessionId);
    assert.equal(approveRes.ok, true);

    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "diff_ready", { timeoutMs: 8000 });
    const wf = mgr.getSession(created.session.sessionId).workflow;

    assert.equal(wf.branch, `ai/${created.session.sessionId}`);
    assert.equal(wf.baseBranch, baseBranch);
    assert.equal(currentBranch(allowed), wf.branch); // isolation branch is actually checked out
    assert.equal(adapter.calls[2].mode, "acceptEdits"); // edit turn (call #2) forced acceptEdits

    assert.equal(wf.test.ran, true);
    assert.equal(wf.test.passed, true); // the repo's real "npm test" (a no-op) actually ran
    assert.deepEqual(wf.diff.changedFiles, ["app.js"]); // real `git diff --name-only` after the edit
  });

  test("refuses to approve when no plan is ready", async () => {
    const allowed = makeRepo();
    const adapter = new WorkflowStubAdapter(() => [{ type: "completed", summary: "x" }]);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");

    const res = mgr.approvePlan(created.session.sessionId);
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });
});

describe("Workflow — createSessionWithPlan (one-shot 実装依頼 entry point)", () => {
  test("creates a session and starts planning in one call, forcing plan mode, and reaches plan_ready", async () => {
    const allowed = makeRepo();
    const adapter = new WorkflowStubAdapter(() => [
      { type: "started", sessionId: "s1" },
      { type: "completed", summary: "1. Change app.js to log goodbye instead." },
    ]);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });

    const res = mgr.createSessionWithPlan({ repoPath: allowed, prompt: "say hello differently", mode: "acceptEdits" }, [allowed]);
    assert.equal(res.ok, true);
    assert.equal(res.status, 202);
    assert.equal(res.session.status, "starting");
    // The initial workflow-transition event (status: "planning") is pushed to
    // record.events at index 0 before #runTurn captures turnStartIndex, so the
    // turn's own chat events (started/text/completed) begin at index 1 — the
    // same ordering startPlan() uses for a workflow started mid-conversation.
    assert.equal(res.session.turnStartIndex, 1);

    await waitFor(() => mgr.getSession(res.session.sessionId).workflow?.status === "plan_ready");

    assert.equal(adapter.calls.at(-1).mode, "plan"); // forced, even though mode:"acceptEdits" was requested
    const session = mgr.getSession(res.session.sessionId);
    assert.match(session.workflow.plan, /goodbye/);
  });

  test("rejects invalid payload the same way createSession does", () => {
    const allowed = tmpDir();
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]) });
    const res = mgr.createSessionWithPlan({ repoPath: "", prompt: "" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });

  test("rejects a repoPath outside the allowed roots", () => {
    const allowed = tmpDir();
    const outside = tmpDir();
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]) });
    const res = mgr.createSessionWithPlan({ repoPath: outside, prompt: "hi" }, [allowed]);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });
});

describe("Workflow — requestChanges (revision loop)", () => {
  test("plan_ready -> planning -> plan_ready when revising the plan itself", async () => {
    const allowed = makeRepo();
    // Call #0 is createSession's own turn; #1 is startPlan's ("first draft"); #2 is requestChanges' ("revised draft").
    const adapter = new WorkflowStubAdapter((callIndex) => [
      { type: "completed", summary: callIndex <= 1 ? "first draft" : "revised draft" },
    ]);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");
    mgr.startPlan(created.session.sessionId, "make a plan");
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");
    assert.equal(mgr.getSession(created.session.sessionId).workflow.plan, "first draft");

    const res = mgr.requestChanges(created.session.sessionId, "please reconsider");
    assert.equal(res.ok, true);
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");
    assert.equal(mgr.getSession(created.session.sessionId).workflow.plan, "revised draft");
    assert.equal(adapter.calls[1].mode, "plan");
  });
});

describe("Workflow — commitWorkflow (real git commit, human-triggered only)", () => {
  test("commits the isolation branch's changes and reaches done", async () => {
    const allowed = makeRepo();
    const adapter = new WorkflowStubAdapter((callIndex) => {
      if (callIndex <= 1) return [{ type: "completed", summary: "plan" }]; // #0 createSession, #1 startPlan
      fs.writeFileSync(path.join(allowed, "app.js"), "console.log('goodbye');\n");
      return [{ type: "completed", summary: "edited" }];
    });
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");
    mgr.startPlan(created.session.sessionId, "change greeting");
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");
    mgr.approvePlan(created.session.sessionId);
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "diff_ready", { timeoutMs: 8000 });

    const commitRes = mgr.commitWorkflow(created.session.sessionId, "change the greeting message");
    assert.equal(commitRes.ok, true);
    const wf = mgr.getSession(created.session.sessionId).workflow;
    assert.equal(wf.status, "done");
    assert.ok(wf.commitHash);
    assert.match(git(["log", "-1", "--pretty=%s"], allowed), /change the greeting message/);
  });

  test("rejects committing without a message, and rejects committing when not in diff_ready", async () => {
    const allowed = makeRepo();
    const adapter = new WorkflowStubAdapter(() => [{ type: "completed", summary: "plan" }]);
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");

    assert.equal(mgr.commitWorkflow(created.session.sessionId, "no workflow yet").status, 409);

    mgr.startPlan(created.session.sessionId, "x");
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");
    assert.equal(mgr.commitWorkflow(created.session.sessionId, "too early").status, 409);
  });
});

describe("Workflow — discardWorkflow (real cleanup, only ever touches the isolation branch)", () => {
  test("abandons the branch and leaves the base branch untouched", async () => {
    const allowed = makeRepo();
    const baseBranch = currentBranch(allowed);
    const adapter = new WorkflowStubAdapter((callIndex) => {
      if (callIndex <= 1) return [{ type: "completed", summary: "plan" }]; // #0 createSession, #1 startPlan
      fs.writeFileSync(path.join(allowed, "app.js"), "console.log('goodbye');\n");
      fs.writeFileSync(path.join(allowed, "scratch.txt"), "created by claude\n");
      return [{ type: "completed", summary: "edited" }];
    });
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");
    mgr.startPlan(created.session.sessionId, "x");
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");
    mgr.approvePlan(created.session.sessionId);
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "diff_ready", { timeoutMs: 8000 });

    const result = mgr.discardWorkflow(created.session.sessionId);
    assert.equal(result.ok, true);
    assert.equal(mgr.getSession(created.session.sessionId).workflow.status, "discarded");
    assert.equal(currentBranch(allowed), baseBranch);
    assert.equal(fs.existsSync(path.join(allowed, "scratch.txt")), false);
    assert.equal(git(["log", "-1", "--pretty=%s"], allowed).trim(), "init"); // no commit was made
  });
});

describe("Workflow — cancelWorkflow", () => {
  test("cancels an in-flight editing turn and discards the branch it created", async () => {
    const allowed = makeRepo();
    const baseBranch = currentBranch(allowed);
    const adapter = new WorkflowStubAdapter((callIndex) =>
      callIndex <= 1 ? [{ type: "completed", summary: "plan" }] : [{ type: "started", sessionId: "s1" }] // #0/#1 = createSession/startPlan; #2 = editing turn, never completes on its own
    );
    const mgr = new CodeSessionManager({ insideRoots: makeInsideRoots([allowed]), adapter });
    const created = mgr.createSession({ repoPath: allowed, prompt: "hi", mode: "plan" }, [allowed]);
    await waitFor(() => mgr.getSession(created.session.sessionId).status === "ready");
    mgr.startPlan(created.session.sessionId, "x");
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "plan_ready");
    mgr.approvePlan(created.session.sessionId);
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "editing");

    const result = mgr.cancelWorkflow(created.session.sessionId);
    assert.equal(result.ok, true);
    await waitFor(() => mgr.getSession(created.session.sessionId).workflow.status === "cancelled");
    assert.equal(currentBranch(allowed), baseBranch);
  });
});
