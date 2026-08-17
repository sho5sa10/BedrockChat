import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { currentBranch, isClean, createIsolationBranch, commit, discardIsolationBranch } from "../code-agent/git-adapter.js";

function tmpDir(prefix = "bedrockchat-gitadapter-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function makeRepo() {
  const dir = tmpDir();
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

describe("git-adapter — isClean / currentBranch", () => {
  test("isClean is true right after a commit, false after an edit", () => {
    const dir = makeRepo();
    assert.equal(isClean(dir), true);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    assert.equal(isClean(dir), false);
  });

  test("currentBranch reports the active branch", () => {
    const dir = makeRepo();
    const branch = currentBranch(dir);
    assert.ok(branch); // "main" or "master" depending on the local git default
  });
});

describe("git-adapter — createIsolationBranch", () => {
  test("creates ai/<sessionId> from a clean tree and switches back into it on re-approval (idempotent)", () => {
    const dir = makeRepo();
    const base = currentBranch(dir);

    const first = createIsolationBranch(dir, "cs_test_1");
    assert.equal(first.ok, true);
    assert.equal(first.branch, "ai/cs_test_1");
    assert.equal(first.baseBranch, base);
    assert.equal(currentBranch(dir), "ai/cs_test_1");

    // Simulate resuming a workflow after a restart: already on the branch.
    const second = createIsolationBranch(dir, "cs_test_1");
    assert.equal(second.ok, true);
    assert.equal(second.branch, "ai/cs_test_1");
  });

  test("refuses to run on a dirty tree, so a user's own uncommitted work is never carried onto the isolation branch", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "one\nuncommitted change\n");

    const result = createIsolationBranch(dir, "cs_test_2");
    assert.equal(result.ok, false);
    assert.match(result.error, /uncommitted/);
    assert.equal(currentBranch(dir) !== "ai/cs_test_2", true); // never switched
  });

  test("sanitizes the session id into a safe branch name", () => {
    const dir = makeRepo();
    const result = createIsolationBranch(dir, "cs 2026/08!!weird");
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.branch, /[ !]/);
  });
});

describe("git-adapter — commit", () => {
  test("stages and commits everything, returning a short hash", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "b.txt"), "new file\n");

    const result = commit(dir, "add b.txt");
    assert.equal(result.ok, true);
    assert.ok(result.hash);
    assert.equal(isClean(dir), true);
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /add b\.txt/);
  });

  test("rejects an empty message and reports cleanly when there is nothing to commit", () => {
    const dir = makeRepo();
    assert.equal(commit(dir, "   ").ok, false);

    const result = commit(dir, "nothing changed");
    assert.equal(result.ok, false);
    assert.match(result.error, /nothing to commit/);
  });
});

describe("git-adapter — discardIsolationBranch", () => {
  test("reverts uncommitted changes, switches back to base, and deletes the isolation branch", () => {
    const dir = makeRepo();
    const base = currentBranch(dir);
    const created = createIsolationBranch(dir, "cs_test_3");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\nclaude's edit\n");
    fs.writeFileSync(path.join(dir, "new-file.txt"), "created by claude\n");

    const result = discardIsolationBranch(dir, created.branch, created.baseBranch);
    assert.equal(result.ok, true);
    assert.equal(currentBranch(dir), base);
    // Windows git may normalize line endings on checkout (core.autocrlf) — compare content, not exact bytes.
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8").trim(), "one"); // reverted
    assert.equal(fs.existsSync(path.join(dir, "new-file.txt")), false); // untracked file cleaned up

    const branches = git(["branch"], dir);
    assert.doesNotMatch(branches, /ai\/cs_test_3/); // branch deleted
  });
});
