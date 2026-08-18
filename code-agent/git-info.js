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
 *
 * `allowExitCodes` exists for the handful of git subcommands that use a
 * non-zero exit status to mean "there is a difference" rather than "this
 * failed" (`git diff --no-index` exits 1 when the files differ) — without
 * it, those calls would be indistinguishable from a real error and get
 * dropped as null.
 */
export function runGit(args, cwd, { allowExitCodes = [] } = {}) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (res.error) return null;
  if (res.status !== 0 && !allowExitCodes.includes(res.status)) return null;
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
 * Untracked-but-not-ignored files, listed individually (`-uall`, so a
 * wholly-new directory reports its files rather than just "dir/").
 *
 * Every diff surface below has to fold these in explicitly: `git diff` is
 * blind to untracked files, yet the workflow's commit stages with
 * `git add -A` — so a brand-new file Claude Code wrote would be committed
 * without ever having appeared in the diff the human approved. Ignored
 * files are excluded on purpose: `git add -A` won't commit them either.
 *
 * `-z` rather than parsing the default output: without it git quotes and
 * octal-escapes any path outside ASCII (`"\346\227\245..."`), which for a
 * repository with Japanese filenames would mean mangled names in the file
 * list and a silently skipped diff. `-z` emits raw, NUL-separated paths.
 * Rename entries (tracked-only, so not matched by the `?? ` filter) add a
 * second unprefixed token, which this simply ignores.
 */
function untrackedFiles(repoPath) {
  const status = runGit(["status", "--porcelain", "-z", "-uall"], repoPath) ?? "";
  return status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}

/**
 * Post-run summary surfaced to the UI: file list + counts, never a full
 * unified diff by default (keeps the response small and avoids dumping a
 * wall of text for large changesets — see captureFullDiff for the
 * on-demand, size-capped expansion used by diff review).
 *
 * Diffed against HEAD rather than the index so that anything Claude Code
 * happened to `git add` itself is still reported; combined with
 * untrackedFiles() above, `changedFiles` is exactly the set of paths the
 * workflow's commit would include.
 */
export function captureGitDiffStat(repoPath) {
  if (!isGitRepo(repoPath)) return null;
  const nameOnly = runGit(["diff", "HEAD", "--name-only"], repoPath) ?? "";
  const shortStat = runGit(["diff", "HEAD", "--shortstat"], repoPath) ?? "";
  const status = runGit(["status", "--porcelain"], repoPath) ?? "";
  const tracked = nameOnly.split("\n").map((l) => l.trim()).filter(Boolean);
  const untracked = untrackedFiles(repoPath);
  return {
    changedFiles: [...tracked, ...untracked.filter((f) => !tracked.includes(f))],
    newFiles: untracked,
    shortStat: shortStat.trim(),
    status,
  };
}

const MAX_DIFF_BYTES = 200 * 1024; // full unified diff, capped so a huge changeset can't blow up the response
const MAX_NEW_FILES_IN_DIFF = 50; // a generated build/vendor directory shouldn't turn diff review into thousands of git calls

/**
 * On-demand full unified diff for diff review — capped, never auto-fetched
 * into the chat stream. Includes new files (via `--no-index` against an
 * empty tree) for the same reason captureGitDiffStat lists them: they are
 * part of what the Commit button will commit, so they have to be part of
 * what the human reviews before pressing it.
 */
export function captureFullDiff(repoPath) {
  if (!isGitRepo(repoPath)) return null;
  const parts = [];
  let bytes = 0;
  const tracked = runGit(["diff", "HEAD"], repoPath) ?? "";
  if (tracked) { parts.push(tracked); bytes += Buffer.byteLength(tracked, "utf8"); }

  const untracked = untrackedFiles(repoPath);
  for (const file of untracked.slice(0, MAX_NEW_FILES_IN_DIFF)) {
    if (bytes > MAX_DIFF_BYTES) break; // already past the cap: no point reading more files into memory just to slice them off
    // `/dev/null` as the "before" side is understood by Git for Windows too,
    // and renders as a normal "new file mode" hunk. Exit code 1 just means
    // "they differ", which is always true here.
    const added = runGit(["diff", "--no-index", "--", "/dev/null", file], repoPath, { allowExitCodes: [1] });
    if (added) { parts.push(added); bytes += Buffer.byteLength(added, "utf8"); }
  }
  if (untracked.length > MAX_NEW_FILES_IN_DIFF) {
    parts.push(`… 新規ファイル ${untracked.length - MAX_NEW_FILES_IN_DIFF} 件は差分表示から省略しました\n`);
  }

  const diff = parts.join("");
  const truncated = Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES;
  return {
    diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) + "\n… (truncated)" : diff,
    truncated,
  };
}
