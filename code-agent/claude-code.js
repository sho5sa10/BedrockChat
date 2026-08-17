import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { quoteForWindowsShell } from "./shell-utils.js";

// child.kill() alone only signals the immediate child. On Windows that
// immediate child is cmd.exe (spawned via shell:true — see below), with the
// real `claude` process one level further down as *its* child; killing just
// cmd.exe leaves that real process running, un-cancelled. taskkill /T kills
// the whole tree. POSIX's plain child.kill() doesn't have this problem
// (no shell wrapper is used there), so it's left as the direct path.
function killProcessTree(child) {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * Normalizes one line of `claude -p --output-format stream-json` output
 * into zero or more of our own event shapes: started | tool | text |
 * completed | error. This is the only place that knows the real CLI's
 * JSONL structure — verified against claude-code CLI 2.1.222 output rather
 * than guessed. That output is far richer than what should ever reach the
 * browser (a captured "system"/"init" line included the full tool roster,
 * connected MCP servers, and a local memory-file path), so anything not
 * explicitly mapped here (rate_limit_event, raw system/init, etc.) is
 * dropped rather than passed through.
 */
function normalizeClaudeLine(raw) {
  const events = [];
  switch (raw?.type) {
    case "system":
      if (raw.subtype === "init") {
        events.push({ type: "started", sessionId: raw.session_id, model: raw.model, mode: raw.permissionMode });
      }
      break;

    case "assistant":
      for (const block of raw.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          events.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          events.push({ type: "tool", tool: block.name, target: summarizeToolInput(block.input) });
        }
      }
      break;

    case "result":
      if (raw.is_error) {
        events.push({
          type: "error",
          code: "execution_error",
          message: firstOf(raw.errors) || raw.subtype || "Claude Code reported an error",
          durationMs: raw.duration_ms,
          costUsd: raw.total_cost_usd,
          usage: summarizeUsage(raw.usage),
        });
      } else {
        events.push({
          type: "completed",
          summary: typeof raw.result === "string" ? raw.result : "",
          durationMs: raw.duration_ms,
          numTurns: raw.num_turns,
          costUsd: raw.total_cost_usd,
          usage: summarizeUsage(raw.usage),
        });
      }
      break;

    default:
      break; // rate_limit_event, user echoes, etc. — intentionally not forwarded
  }
  return events;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return undefined;
  return input.file_path || input.path || input.command || input.pattern || input.query || undefined;
}

function firstOf(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : undefined;
}

// raw.usage on the "result" line — verified against real 2.1.222 output:
// {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ...}
function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Adapter that isolates "how to launch and read Claude Code" from the rest
 * of the app. CodeAgent only ever sees the normalized events above via the
 * EventEmitter returned by execute(); it has no idea a CLI subprocess or a
 * JSONL wire format is involved. That's what lets the launch mechanism
 * evolve later (a real SDK session, MCP) without touching CodeAgent or
 * server.js.
 *
 * The prompt is sent over stdin rather than as a CLI argument — verified
 * against the installed CLI (`claude -p` reads the prompt from stdin when
 * none is given positionally). Every other argv token is a fixed flag or
 * an enum-validated value, never raw user text, which matters on Windows
 * where .cmd shims need shell:true to launch at all, and shell:true only
 * concatenates argv rather than escaping it (see quoteForWindowsShell).
 *
 * execute() returns immediately; the run happens in the background and is
 * reported entirely through emitted "event" objects. Exactly one terminal
 * event — "completed", "error", or "cancelled" — is guaranteed to be
 * emitted last. The returned emitter also carries a cancel() method that
 * kills the underlying process (or, if called before it's even spawned,
 * pre-empts the spawn) and resolves that terminal event to "cancelled".
 */
export class ClaudeCodeAdapter {
  constructor({ command, extraArgs = [] } = {}) {
    this.command = command || process.env.CLAUDE_CLI_PATH || "claude";
    // Test-only hook: lets tests point the adapter at a fixture script
    // (e.g. [fixturePath]) instead of a real "claude" binary.
    this.extraArgs = extraArgs;
  }

  isCommandAvailable() {
    if (this.command.includes("/") || this.command.includes("\\")) {
      return fs.existsSync(this.command);
    }
    const finder = process.platform === "win32" ? "where" : "which";
    const probe = spawnSync(finder, [this.command], { windowsHide: true });
    if (probe.error) return true; // finder itself unavailable: fail open, let spawn decide
    return probe.status === 0;
  }

  execute(request) {
    const emitter = new EventEmitter();
    const state = { cancelled: false, child: null };
    emitter.cancel = () => {
      if (state.cancelled) return;
      state.cancelled = true;
      if (state.child) killProcessTree(state.child);
    };
    // Deferred so callers can attach "event" listeners (and call cancel())
    // before anything fires.
    setImmediate(() => this.#run(request, emitter, state));
    return emitter;
  }

  #run(request, emitter, state) {
    const emit = (evt) => emitter.emit("event", evt);

    if (state.cancelled) {
      emit({ type: "cancelled" });
      return;
    }
    if (!this.isCommandAvailable()) {
      emit({ type: "error", code: "cli_not_found", message: `"${this.command}" was not found on PATH` });
      return;
    }

    const args = [
      ...this.extraArgs,
      "-p",
      "--permission-mode",
      request.mode,
      "--output-format",
      "stream-json",
      "--verbose", // required by this CLI version to stream JSONL in print mode (verified live)
    ];
    if (Array.isArray(request.allowedTools) && request.allowedTools.length) {
      args.push("--allowed-tools", request.allowedTools.join(","));
    }
    if (request.resumeSessionId) {
      // Continues a prior turn's conversation (verified real flag: `-r/--resume <id>`).
      // request.resumeSessionId is always a session_id we captured from Claude's own
      // "started" event on an earlier turn — never raw user text.
      args.push("--resume", request.resumeSessionId);
    }

    const useShell = process.platform === "win32";
    const spawnCommand = useShell ? quoteForWindowsShell(this.command) : this.command;
    const spawnArgs = useShell ? args.map(quoteForWindowsShell) : args;

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd: request.repoPath,
        shell: useShell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      emit({ type: "error", code: "spawn_failed", message: err.message });
      return;
    }
    state.child = child; // makes it killable via emitter.cancel() from this point on
    if (state.cancelled) killProcessTree(child);

    let spawnedOk = false;
    let sawResultLine = false;
    const stderrChunks = [];
    child.stderr?.on("data", (d) => stderrChunks.push(d));

    child.once("spawn", () => {
      spawnedOk = true;
      child.stdin.on("error", () => {}); // e.g. EPIPE if the child exits before reading
      child.stdin.write(request.prompt);
      child.stdin.end();
    });

    child.once("error", (err) => {
      if (!spawnedOk) emit({ type: "error", code: "spawn_failed", message: err.message });
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let raw;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON output rather than crash the run
      }
      if (raw.type === "result") sawResultLine = true;
      for (const evt of normalizeClaudeLine(raw)) emit(evt);
    });

    child.once("close", (code) => {
      if (!spawnedOk || sawResultLine) return; // already reported via 'error' or a result line
      if (state.cancelled) { emit({ type: "cancelled" }); return; }
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
      emit({
        type: "error",
        code: "execution_error",
        message: stderrText ? stderrText.slice(0, 1000) : `claude exited with code ${code}`,
      });
    });

    child.unref();
  }
}
