import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { validateCodeAgentRequest, DEFAULT_MODE, MAX_PROMPT_BYTES } from "./contract.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { captureGitDiffStat, captureFullDiff } from "./git-info.js";
import { createIsolationBranch, commit as gitCommit, discardIsolationBranch } from "./git-adapter.js";
import { runTests } from "./test-runner.js";

const MAX_EVENTS_PER_SESSION = 1000; // a chat session accumulates events across many turns

function makeSessionId(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `cs_${y}${m}${d}_${crypto.randomBytes(4).toString("hex")}`;
}

function workflowSnapshot(wf) {
  if (!wf) return null;
  return {
    status: wf.status,
    plan: wf.plan,
    branch: wf.branch,
    baseBranch: wf.baseBranch,
    test: wf.test,
    diff: wf.diff,
    commitHash: wf.commitHash ?? null,
    error: wf.error,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
  };
}

function safely(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * CodeSessionManager is the "Claude Code as a chat backend" counterpart to
 * CodeAgent's one-shot implementation requests. Where CodeAgent fires a
 * single prompt and reports started/completed once, a session is a
 * continuing conversation: createSession() sends the first turn, then
 * sendMessage() sends further turns against the *same* Claude Code
 * conversation via `--resume`.
 *
 * Two ids exist per session on purpose: `sessionId` is ours, minted at
 * creation so the client has something to address before Claude Code has
 * even run once; `claudeSessionId` is the real CLI session id, only known
 * once the first turn's "started" event arrives, and is what actually gets
 * passed to `--resume` on turn 2+. No process is kept running between
 * turns — each turn is its own short-lived `claude -p` invocation that
 * loads prior history via `--resume`, verified against the installed CLI.
 *
 * On top of plain chat, a session can carry one *workflow* at a time — the
 * Plan → Human Approval → Edit → Test → Diff → Human Approval → Commit
 * loop. A workflow is optional and explicit (startPlan()), never implied
 * by an ordinary chat message, per the design principle that BedrockChat
 * stays a chat UI first and an "implementation request form" only when
 * the user deliberately asks for that structure:
 *
 *   planning -> plan_ready -> editing -> testing -> diff_ready -> done
 *                  |                         ^  |
 *                  `---- requestChanges -----'  `-- requestChanges --> editing
 *
 * failed/cancelled/discarded are reachable from planning/editing/plan_ready/
 * diff_ready and are terminal. Only two things in this whole class ever
 * mutate the repository's git state — approvePlan() (creates an isolation
 * branch) and commitWorkflow() (commits) — and both only run in direct
 * response to an explicit human action, never automatically. No path here
 * ever pushes or merges.
 *
 * server.js only ever talks to this class (create/send/get/subscribe/
 * workflow methods), exactly like it only ever talks to CodeAgent — it has
 * no idea Claude Code, `--resume`, or stream-json are involved.
 */
export class CodeSessionManager {
  constructor({ insideRoots, adapter } = {}) {
    if (typeof insideRoots !== "function") {
      throw new Error("CodeSessionManager requires an insideRoots(path) function");
    }
    this.insideRoots = insideRoots;
    this.adapter = adapter || new ClaudeCodeAdapter();
    this.sessions = new Map();
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
  }

  createSession(input, allowedRoots) {
    const built = this.#buildSessionRecord(input, allowedRoots);
    if (!built.ok) return built;
    const record = built.record;

    // Snapshot before #runTurn synchronously advances the record to
    // "running" — the HTTP response reports the initial "starting"
    // acknowledgment; callers track further progress via GET/SSE.
    const initialStatus = record.status;
    this.#runTurn(record, input.prompt);
    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: initialStatus, turnStartIndex: record.turnStartIndex } };
  }

  /**
   * The one-shot "実装を依頼" entry point's counterpart to createSession():
   * creates the session *and* immediately puts it into the same Plan ->
   * Approval -> Edit -> Test -> Diff -> Approval -> Commit workflow a chat
   * session's own 📋 button starts — so a one-shot request gets the exact
   * same safety loop as a request made mid-conversation, via the same
   * code path, rather than a second, less-supervised implementation.
   */
  createSessionWithPlan(input, allowedRoots) {
    const built = this.#buildSessionRecord(input, allowedRoots);
    if (!built.ok) return built;
    const record = built.record;

    const now = new Date().toISOString();
    record.workflow = {
      status: "planning", plan: null, branch: null, baseBranch: null,
      test: null, diff: null, commitHash: null, error: null,
      createdAt: now, updatedAt: now,
    };

    const initialStatus = record.status;
    this.#emitWorkflowEvent(record);
    this.#runTurn(record, input.prompt, "plan"); // forced, regardless of input.mode — see startPlan()
    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: initialStatus, turnStartIndex: record.turnStartIndex } };
  }

  #buildSessionRecord(input, allowedRoots) {
    const errors = validateCodeAgentRequest(input);
    if (errors.length) return { ok: false, status: 400, errors };

    if (!(allowedRoots ?? []).length) {
      return { ok: false, status: 403, errors: ["no allowed roots are registered"] };
    }

    const repoPath = path.resolve(String(input.repoPath));
    if (!this.insideRoots(repoPath)) {
      return { ok: false, status: 403, errors: ["repoPath is outside the allowed roots"] };
    }

    let stat;
    try {
      stat = fs.statSync(repoPath);
    } catch {
      return { ok: false, status: 400, errors: ["repoPath does not exist"] };
    }
    if (!stat.isDirectory()) {
      return { ok: false, status: 400, errors: ["repoPath is not a directory"] };
    }

    const now = new Date().toISOString();
    const record = {
      sessionId: makeSessionId(),
      claudeSessionId: null,
      repoPath,
      mode: input.mode || DEFAULT_MODE,
      status: "starting",
      busy: true,
      createdAt: now,
      updatedAt: now,
      error: null,
      events: [],
      turnStartIndex: 0, // event index the in-flight (or most recent) turn began at — lets a client that lost its live connection (e.g. a browser refresh) reattach and skip only prior turns' events
      currentRun: null, // the adapter's EventEmitter handle for the in-flight turn, if any — what cancelTurn() calls .cancel() on
      workflow: null,
    };
    this.sessions.set(record.sessionId, record);
    return { ok: true, record };
  }

  sendMessage(sessionId, prompt) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };

    const promptErrors = this.#validatePrompt(prompt);
    if (promptErrors.length) return { ok: false, status: 400, errors: promptErrors };
    if (record.busy) {
      return { ok: false, status: 409, errors: ["session is still processing the previous message"] };
    }

    this.#runTurn(record, prompt);

    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: record.status, turnStartIndex: record.turnStartIndex } };
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /** On-demand full unified diff for diff review — capped, never pushed into the event stream on its own. */
  getFullDiff(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    const result = safely(() => captureFullDiff(record.repoPath));
    if (!result) return { ok: false, status: 409, errors: ["not a git repository, or diff could not be read"] };
    return { ok: true, status: 200, diff: result };
  }

  cancelTurn(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    if (!record.busy || !record.currentRun) {
      return { ok: false, status: 409, errors: ["no turn is currently running"] };
    }
    record.currentRun.cancel();
    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: record.status } };
  }

  /** Replays buffered events, then streams new ones — same contract as CodeAgent.subscribe. */
  subscribe(sessionId, onEvent) {
    this.bus.on(sessionId, onEvent);
  }

  unsubscribe(sessionId, onEvent) {
    this.bus.off(sessionId, onEvent);
  }

  // ------------------------------------------------------------------
  // Workflow: Plan -> Human Approval -> Edit -> Test -> Diff -> Human
  // Approval -> Commit. See class docstring for the full state diagram.
  // ------------------------------------------------------------------

  startPlan(sessionId, prompt) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };

    const promptErrors = this.#validatePrompt(prompt);
    if (promptErrors.length) return { ok: false, status: 400, errors: promptErrors };
    if (record.busy) return { ok: false, status: 409, errors: ["session is still processing the previous message"] };
    if (record.workflow && !["done", "discarded", "failed", "cancelled"].includes(record.workflow.status)) {
      return { ok: false, status: 409, errors: ["a workflow is already in progress for this session"] };
    }

    const now = new Date().toISOString();
    record.workflow = {
      status: "planning", plan: null, branch: null, baseBranch: null,
      test: null, diff: null, commitHash: null, error: null,
      createdAt: now, updatedAt: now,
    };
    this.#emitWorkflowEvent(record);
    this.#runTurn(record, prompt, "plan");

    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: record.status, turnStartIndex: record.turnStartIndex } };
  }

  approvePlan(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    const wf = record.workflow;
    if (!wf || wf.status !== "plan_ready") return { ok: false, status: 409, errors: ["no plan is ready for approval"] };
    if (record.busy) return { ok: false, status: 409, errors: ["session is busy"] };

    const branch = createIsolationBranch(record.repoPath, record.sessionId);
    if (!branch.ok) {
      wf.error = branch.error;
      this.#emitWorkflowEvent(record);
      return { ok: false, status: 409, errors: [branch.error] };
    }
    wf.branch = branch.branch;
    wf.baseBranch = branch.baseBranch;
    wf.error = null;
    this.#setWorkflowStatus(record, "editing");

    this.#runTurn(record, "先ほど提示した計画のとおりに実装してください。", "acceptEdits");
    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: record.status, turnStartIndex: record.turnStartIndex } };
  }

  requestChanges(sessionId, feedback) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    const feedbackErrors = this.#validatePrompt(feedback);
    if (feedbackErrors.length) return { ok: false, status: 400, errors: feedbackErrors };
    if (record.busy) return { ok: false, status: 409, errors: ["session is busy"] };

    const wf = record.workflow;
    if (!wf) return { ok: false, status: 409, errors: ["no workflow in progress"] };

    if (wf.status === "plan_ready") {
      this.#setWorkflowStatus(record, "planning");
      this.#runTurn(record, feedback, "plan");
    } else if (wf.status === "diff_ready") {
      this.#setWorkflowStatus(record, "editing");
      this.#runTurn(record, feedback, "acceptEdits");
    } else {
      return { ok: false, status: 409, errors: ["workflow is not awaiting feedback right now"] };
    }

    return { ok: true, status: 202, session: { sessionId: record.sessionId, status: record.status, turnStartIndex: record.turnStartIndex } };
  }

  /** The only place a commit happens — always a direct response to this explicit call, never automatic. */
  commitWorkflow(sessionId, message) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    const wf = record.workflow;
    if (!wf || wf.status !== "diff_ready") return { ok: false, status: 409, errors: ["no diff is ready to commit"] };
    if (typeof message !== "string" || !message.trim()) return { ok: false, status: 400, errors: ["commit message is required"] };

    const result = gitCommit(record.repoPath, message);
    if (!result.ok) {
      wf.error = result.error;
      this.#emitWorkflowEvent(record);
      return { ok: false, status: 409, errors: [result.error] };
    }
    wf.commitHash = result.hash;
    wf.error = null;
    this.#setWorkflowStatus(record, "done");
    return { ok: true, status: 200, session: { sessionId: record.sessionId } };
  }

  /** Abandons the isolation branch and everything on it. Never touches anything outside that branch. */
  discardWorkflow(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    const wf = record.workflow;
    if (!wf || !["plan_ready", "diff_ready", "failed"].includes(wf.status)) {
      return { ok: false, status: 409, errors: ["nothing to discard right now"] };
    }
    if (wf.branch) {
      const result = discardIsolationBranch(record.repoPath, wf.branch, wf.baseBranch);
      if (!result.ok) {
        wf.error = result.error;
        this.#emitWorkflowEvent(record);
        return { ok: false, status: 409, errors: [result.error] };
      }
    }
    this.#setWorkflowStatus(record, "discarded");
    return { ok: true, status: 200, session: { sessionId: record.sessionId } };
  }

  /** Cancels an in-flight planning/editing turn (if any) and discards the isolation branch (if one was created). */
  cancelWorkflow(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, errors: ["session not found"] };
    const wf = record.workflow;
    if (!wf || ["done", "discarded", "cancelled"].includes(wf.status)) {
      return { ok: false, status: 409, errors: ["no active workflow to cancel"] };
    }
    if (record.busy && record.currentRun) record.currentRun.cancel(); // lands as a normal "cancelled" turn event
    if (wf.branch) discardIsolationBranch(record.repoPath, wf.branch, wf.baseBranch);
    this.#setWorkflowStatus(record, "cancelled");
    return { ok: true, status: 200, session: { sessionId: record.sessionId } };
  }

  #validatePrompt(text) {
    if (typeof text !== "string" || !text.trim()) return ["prompt is required"];
    if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) return [`prompt must be ${MAX_PROMPT_BYTES} bytes or fewer`];
    return [];
  }

  #runTurn(record, prompt, modeOverride) {
    record.busy = true;
    record.turnStartIndex = record.events.length;
    this.#setStatus(record, "running");

    let run;
    try {
      run = this.adapter.execute({
        repoPath: record.repoPath,
        prompt,
        mode: modeOverride || record.mode,
        resumeSessionId: record.claudeSessionId || undefined,
      });
    } catch (err) {
      this.#handleEvent(record, { type: "error", code: "internal_error", message: err.message });
      return;
    }

    record.currentRun = run;
    run.on("event", (evt) => this.#handleEvent(record, evt));
  }

  /**
   * Appends an event and trims the log to MAX_EVENTS_PER_SESSION, keeping
   * turnStartIndex — an absolute index into `events` — correct as the front
   * of the array shifts. Getting this wrong doesn't just mis-render old
   * history: reconnecting clients skip exactly turnStartIndex replayed
   * events (see GET .../events), so a stale index makes them skip *into*
   * the current turn's own events, silently dropping part of a live reply.
   */
  #pushEvent(record, stamped) {
    record.events.push(stamped);
    if (record.events.length > MAX_EVENTS_PER_SESSION) {
      record.events.shift();
      record.turnStartIndex = Math.max(0, record.turnStartIndex - 1);
    }
    record.updatedAt = stamped.timestamp;
  }

  #handleEvent(record, evt) {
    const stamped = { ...evt, timestamp: new Date().toISOString() };
    this.#pushEvent(record, stamped);

    if (evt.type === "started") {
      // First turn only: later turns already know claudeSessionId and just resume it.
      record.claudeSessionId = record.claudeSessionId || evt.sessionId || null;
      this.#setStatus(record, "running", false);
    } else if (evt.type === "completed") {
      record.busy = false;
      record.error = null;
      record.currentRun = null;
      this.#onTurnCompleted(record, evt);
    } else if (evt.type === "error") {
      record.busy = false;
      record.error = evt.message ?? "unknown error";
      record.currentRun = null;
      // "failed" describes this turn's outcome, not a dead end — the next
      // sendMessage() is still allowed, and resumes from the last known
      // claudeSessionId (or starts fresh if that first turn never got one).
      this.#setStatus(record, "failed", false);
      if (record.workflow && ["planning", "editing"].includes(record.workflow.status)) {
        record.workflow.error = record.error;
        this.#setWorkflowStatus(record, "failed");
      }
    } else if (evt.type === "cancelled") {
      record.busy = false;
      record.error = null;
      record.currentRun = null;
      // Like "failed", not a dead end: the session can still take new messages.
      this.#setStatus(record, "cancelled", false);
      if (record.workflow && ["planning", "editing"].includes(record.workflow.status)) {
        // Turn was interrupted via cancelTurn() directly rather than
        // cancelWorkflow() — branch cleanup is left to an explicit
        // discardWorkflow()/cancelWorkflow() call rather than done silently here.
        this.#setWorkflowStatus(record, "failed");
      }
    }

    this.bus.emit(record.sessionId, stamped);
  }

  #onTurnCompleted(record, evt) {
    const wf = record.workflow;
    if (!wf) {
      this.#setStatus(record, "ready", false);
      return;
    }
    if (wf.status === "planning") {
      wf.plan = evt.summary || "";
      this.#setStatus(record, "ready", false);
      this.#setWorkflowStatus(record, "plan_ready");
    } else if (wf.status === "editing") {
      this.#setStatus(record, "ready", false);
      this.#setWorkflowStatus(record, "testing");
      this.#runTestsAndCaptureDiff(record); // async, fire-and-forget — reported via its own workflow event on completion
    } else {
      this.#setStatus(record, "ready", false);
    }
  }

  async #runTestsAndCaptureDiff(record) {
    const wf = record.workflow;
    try {
      wf.test = await runTests(record.repoPath);
    } catch (err) {
      wf.test = { ran: false, reason: err.message };
    }
    wf.diff = safely(() => captureGitDiffStat(record.repoPath));
    this.#setWorkflowStatus(record, "diff_ready");
  }

  #setWorkflowStatus(record, status) {
    record.workflow.status = status;
    record.workflow.updatedAt = new Date().toISOString();
    this.#emitWorkflowEvent(record);
  }

  #emitWorkflowEvent(record) {
    const stamped = { type: "workflow", workflow: workflowSnapshot(record.workflow), timestamp: new Date().toISOString() };
    this.#pushEvent(record, stamped);
    this.bus.emit(record.sessionId, stamped);
  }

  #setStatus(record, status, touchUpdatedAt = true) {
    record.status = status;
    if (touchUpdatedAt) record.updatedAt = new Date().toISOString();
  }
}
