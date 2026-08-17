import { spawnSync } from "node:child_process";

/**
 * Read-only git helpers used by CodeAgent/CodeSessionManager to summarize
 * what Claude Code changed. Nothing here ever mutates the repository —
 * branch/commit/discard live in git-adapter.js instead, deliberately kept
 * in a separate file since those are the only git operations in this app
 * that change repository state, and only ever triggered by an explicit
 * human action (see its own docstring). `git` on Windows is a real
 * executable (not a .cmd shim), so this needs none of ClaudeCodeAdapter's
 * shell-quoting handling.
 */
export function runGit(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

export function isGitRepo(repoPath) {
  return runGit(["rev-parse", "--is-inside-work-tree"], repoPath)?.trim() === "true";
}

/** Lightweight pre-run snapshot, kept for internal context only. */
export function captureGitStatus(repoPath) {
  if (!isGitRepo(repoPath)) return null;
  const status = runGit(["status", "--porcelain"], repoPath);
  return { status: status ?? "" };
}

/**
 * Post-run summary surfaced to the UI: file list + counts, never a full
 * unified diff by default (keeps the response small and avoids dumping a
 * wall of text for large changesets — see captureFullDiff for the
 * on-demand, size-capped expansion used by diff review).
 */
export function captureGitDiffStat(repoPath) {
  if (!isGitRepo(repoPath)) return null;
  const nameOnly = runGit(["diff", "--name-only"], repoPath) ?? "";
  const shortStat = runGit(["diff", "--shortstat"], repoPath) ?? "";
  const status = runGit(["status", "--porcelain"], repoPath) ?? "";
  return {
    changedFiles: nameOnly.split("\n").map((l) => l.trim()).filter(Boolean),
    shortStat: shortStat.trim(),
    status,
  };
}

const MAX_DIFF_BYTES = 200 * 1024; // full unified diff, capped so a huge changeset can't blow up the response

/** On-demand full unified diff for diff review — capped, never auto-fetched into the chat stream. */
export function captureFullDiff(repoPath) {
  if (!isGitRepo(repoPath)) return null;
  const diff = runGit(["diff"], repoPath) ?? "";
  const truncated = Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES;
  return {
    diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) + "\n… (truncated)" : diff,
    truncated,
  };
}
