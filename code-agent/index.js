import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { validateCodeAgentRequest, DEFAULT_MODE } from "./contract.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { captureGitStatus, captureGitDiffStat } from "./git-info.js";

const MAX_EVENTS_PER_REQUEST = 500;

function makeRequestId(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `cr_${y}${m}${d}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * CodeAgent is the boundary between BedrockChat (server.js) and however
 * Claude Code actually gets launched and reported on. server.js only ever
 * talks to this class: it creates requests, reads status, and subscribes
 * to normalized progress events — it never spawns a process, parses CLI
 * output, or runs git itself. That indirection is what lets the launch
 * mechanism evolve later (real sessions, MCP, Agent Teams) without
 * server.js or the HTTP/SSE contract changing.
 *
 * Repository access reuses the existing allowedRoots / insideRoots()
 * mechanism from server.js; this module does not introduce a second
 * access-control system.
 *
 * createRequest() returns as soon as the request is validated and
 * recorded — it does not wait for Claude Code to launch, let alone
 * finish. The actual run proceeds in the background and is reported
 * through the normalized event log / subscribe().
 */
export class CodeAgent {
  constructor({ insideRoots, adapter } = {}) {
    if (typeof insideRoots !== "function") {
      throw new Error("CodeAgent requires an insideRoots(path) function");
    }
    this.insideRoots = insideRoots;
    this.adapter = adapter || new ClaudeCodeAdapter();
    this.requests = new Map();
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
  }

  listRepos(allowedRoots) {
    return (allowedRoots ?? []).map((p) => ({ path: p, name: path.basename(p) || p }));
  }

  createRequest(input, allowedRoots) {
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
      requestId: makeRequestId(),
      repoPath,
      prompt: input.prompt,
      mode: input.mode || DEFAULT_MODE,
      allowedTools: input.allowedTools,
      maxTurns: input.maxTurns,
      status: "accepted",
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      error: null,
      summary: null,
      durationMs: null,
      costUsd: null,
      git: { before: null, after: null },
      events: [],
      currentRun: null,
    };
    this.requests.set(record.requestId, record);

    // Snapshot before #launch synchronously advances the record to
    // "starting" — the HTTP response reports the initial "accepted"
    // acknowledgment; callers track further progress via GET/SSE.
    const initialStatus = record.status;
    this.#launch(record);

    return { ok: true, status: 202, request: { requestId: record.requestId, status: initialStatus } };
  }

  getRequest(requestId) {
    return this.requests.get(requestId) || null;
  }

  cancelRequest(requestId) {
    const record = this.requests.get(requestId);
    if (!record) return { ok: false, status: 404, errors: ["request not found"] };
    if (!record.currentRun || !["accepted", "starting", "running"].includes(record.status)) {
      return { ok: false, status: 409, errors: ["request is not currently running"] };
    }
    record.currentRun.cancel();
    return { ok: true, status: 202, request: { requestId: record.requestId, status: record.status } };
  }

  /** Replays buffered events, then streams new ones until unsubscribe() or the request finishes. */
  subscribe(requestId, onEvent) {
    this.bus.on(requestId, onEvent);
  }

  unsubscribe(requestId, onEvent) {
    this.bus.off(requestId, onEvent);
  }

  #launch(record) {
    record.git.before = safely(() => captureGitStatus(record.repoPath));
    this.#setStatus(record, "starting");

    let run;
    try {
      run = this.adapter.execute({
        repoPath: record.repoPath,
        prompt: record.prompt,
        mode: record.mode,
        allowedTools: record.allowedTools,
        maxTurns: record.maxTurns,
      });
    } catch (err) {
      this.#handleEvent(record, { type: "error", code: "internal_error", message: err.message });
      return;
    }

    record.currentRun = run;
    run.on("event", (evt) => this.#handleEvent(record, evt));
  }

  #handleEvent(record, evt) {
    // Terminal states already reached (e.g. a stray late event) shouldn't regress the record.
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return;

    const stamped = { ...evt, timestamp: new Date().toISOString() };
    record.events.push(stamped);
    if (record.events.length > MAX_EVENTS_PER_REQUEST) record.events.shift();
    record.updatedAt = stamped.timestamp;

    if (evt.type === "started") {
      record.startedAt = record.startedAt ?? stamped.timestamp;
      this.#setStatus(record, "running", false);
    } else if (evt.type === "completed") {
      record.summary = evt.summary ?? "";
      record.durationMs = evt.durationMs ?? null;
      record.costUsd = evt.costUsd ?? null;
      record.currentRun = null;
      record.git.after = safely(() => captureGitDiffStat(record.repoPath));
      this.#setStatus(record, "completed", false);
    } else if (evt.type === "error") {
      record.error = evt.message ?? "unknown error";
      record.currentRun = null;
      record.git.after = safely(() => captureGitDiffStat(record.repoPath));
      this.#setStatus(record, "failed", false);
    } else if (evt.type === "cancelled") {
      record.currentRun = null;
      record.git.after = safely(() => captureGitDiffStat(record.repoPath));
      this.#setStatus(record, "cancelled", false);
    }

    this.bus.emit(record.requestId, stamped);
  }

  #setStatus(record, status, touchUpdatedAt = true) {
    record.status = status;
    if (touchUpdatedAt) record.updatedAt = new Date().toISOString();
  }
}

function safely(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
