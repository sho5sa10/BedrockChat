/**
 * CodeAgentRequest contract.
 *
 * repoPath, mode and allowedTools are structured fields, never parsed out of
 * the free-text prompt — the prompt is not trusted to carry system directives.
 *
 *   CodeAgentRequest = {
 *     requestId: string,
 *     repoPath: string,
 *     prompt: string,
 *     mode: "plan" | "acceptEdits",
 *     allowedTools?: string[],
 *     maxTurns?: number,
 *   }
 */

export const MODES = Object.freeze(["plan", "acceptEdits"]);
export const DEFAULT_MODE = "plan";
export const MAX_PROMPT_BYTES = 64 * 1024;

// Phase 1 lifecycle. "cancelled" is a reserved terminal state for a future
// phase — nothing in Phase 1 transitions a request into it yet.
export const REQUEST_STATUSES = Object.freeze([
  "accepted",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// Conservative whitelist for tool-name tokens (e.g. "Bash", "Edit"). This is a
// forward-looking hook for Phase 1+ — Phase 0 never populates allowedTools
// from user input.
const TOOL_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

export function validateCodeAgentRequest(input) {
  const errors = [];
  const { repoPath, prompt, mode, allowedTools, maxTurns } = input ?? {};

  if (typeof repoPath !== "string" || !repoPath.trim()) {
    errors.push("repoPath is required");
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    errors.push("prompt is required");
  } else if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    errors.push(`prompt must be ${MAX_PROMPT_BYTES} bytes or fewer`);
  }

  if (mode !== undefined && !MODES.includes(mode)) {
    errors.push(`mode must be one of: ${MODES.join(", ")}`);
  }

  if (allowedTools !== undefined) {
    const ok =
      Array.isArray(allowedTools) &&
      allowedTools.every((t) => typeof t === "string" && TOOL_NAME_RE.test(t));
    if (!ok) errors.push("allowedTools must be an array of simple tool names");
  }

  if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) {
    errors.push("maxTurns must be a positive integer");
  }

  return errors;
}
