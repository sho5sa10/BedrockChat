import { runGit, isGitRepo } from "./git-info.js";

/**
 * The only module in this app that mutates a repository's git state
 * (branch / commit / discard). Everything else that touches git
 * (git-info.js) is strictly read-only. Every function here is only ever
 * invoked in direct response to an explicit human action from the
 * workflow UI (approve plan → branch, click Commit → commit, click
 * Discard → discard) — never automatically, and never as a side effect
 * of a chat turn. No function here pushes or merges; that stays out of
 * scope entirely.
 */

function sanitizeBranchName(name) {
  return String(name).replace(/[^A-Za-z0-9_\-/]/g, "-");
}

export function currentBranch(repoPath) {
  const out = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return out ? out.trim() : null;
}

/** True only when there is nothing uncommitted — the precondition for safely creating an isolation branch. */
export function isClean(repoPath) {
  const status = runGit(["status", "--porcelain"], repoPath);
  return status !== null && status.trim() === "";
}

/**
 * Creates (or switches to, if it already exists — e.g. resuming a workflow
 * after a server restart) an isolation branch for this workflow. Callers
 * must check isClean() first; this refuses to run on a dirty tree so a
 * user's own uncommitted work is never carried onto (and later discarded
 * from) the isolation branch by mistake.
 */
export function createIsolationBranch(repoPath, sessionId) {
  if (!isGitRepo(repoPath)) return { ok: false, error: "not a git repository" };
  if (!isClean(repoPath)) {
    return { ok: false, error: "repository has uncommitted changes — commit or stash them first" };
  }
  const branch = `ai/${sanitizeBranchName(sessionId)}`;
  const baseBranch = currentBranch(repoPath);
  if (baseBranch === branch) return { ok: true, branch, baseBranch };

  const created = runGit(["checkout", "-b", branch], repoPath);
  if (created !== null) return { ok: true, branch, baseBranch };

  // -b fails if the branch already exists (e.g. this workflow resumed after a restart) — switch to it instead.
  const switched = runGit(["checkout", branch], repoPath);
  if (switched !== null) return { ok: true, branch, baseBranch };

  return { ok: false, error: `could not create or switch to branch ${branch}` };
}

/** git add -A && git commit -m <message>. Rejects an empty message; reports cleanly if there's nothing to commit. */
export function commit(repoPath, message) {
  if (!isGitRepo(repoPath)) return { ok: false, error: "not a git repository" };
  if (typeof message !== "string" || !message.trim()) return { ok: false, error: "commit message is required" };

  if (runGit(["add", "-A"], repoPath) === null) {
    return { ok: false, error: "git add failed" };
  }
  const status = runGit(["status", "--porcelain"], repoPath);
  if (status !== null && status.trim() === "") {
    return { ok: false, error: "nothing to commit" };
  }
  const result = runGit(["commit", "-m", message], repoPath);
  if (result === null) return { ok: false, error: "git commit failed" };

  const hash = runGit(["rev-parse", "--short", "HEAD"], repoPath);
  return { ok: true, hash: hash ? hash.trim() : null };
}

/**
 * Abandons everything the workflow did: discards uncommitted changes on the
 * isolation branch, switches back to the base branch, and deletes the
 * isolation branch. Safe specifically because createIsolationBranch()
 * refused to start unless the tree was clean beforehand — so everything
 * being discarded here is guaranteed to belong to this workflow, never the
 * user's own pre-existing work.
 */
export function discardIsolationBranch(repoPath, branch, baseBranch) {
  if (!isGitRepo(repoPath)) return { ok: false, error: "not a git repository" };
  runGit(["checkout", "--", "."], repoPath);
  runGit(["clean", "-fd"], repoPath);
  if (baseBranch && currentBranch(repoPath) !== baseBranch) {
    if (runGit(["checkout", baseBranch], repoPath) === null) {
      return { ok: false, error: `discarded changes, but could not switch back to ${baseBranch}` };
    }
  }
  if (branch && branch !== baseBranch) {
    runGit(["branch", "-D", branch], repoPath); // best-effort; leaving the (now-abandoned) branch around isn't harmful
  }
  return { ok: true };
}
