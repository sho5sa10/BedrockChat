import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { captureGitDiffStat, captureFullDiff, isGitRepo } from "../code-agent/git-info.js";

function tmpDir(prefix = "claude-desk-gitinfo-") {
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
  fs.writeFileSync(path.join(dir, "app.js"), "console.log('hello');\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/**
 * These cover the review-integrity invariant behind the whole diff surface:
 * what diff review shows the human must be everything the Commit button
 * (`git add -A && git commit`) would actually commit. Plain `git diff` is
 * blind to both untracked files and anything already staged, so either gap
 * lets a file get committed that never appeared in the reviewed diff.
 */
describe("git-info — captureGitDiffStat covers everything the workflow's commit would include", () => {
  test("reports tracked edits", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "app.js"), "console.log('goodbye');\n");

    const result = captureGitDiffStat(dir);
    assert.deepEqual(result.changedFiles, ["app.js"]);
    assert.deepEqual(result.newFiles, []);
    assert.match(result.shortStat, /1 file changed/);
  });

  test("reports brand-new untracked files, including ones nested in a new directory", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "added.js"), "export const x = 1;\n");
    fs.mkdirSync(path.join(dir, "lib"));
    fs.writeFileSync(path.join(dir, "lib", "deep.js"), "export const y = 2;\n");

    const result = captureGitDiffStat(dir);
    assert.deepEqual(result.newFiles.sort(), ["added.js", "lib/deep.js"]);
    assert.deepEqual(result.changedFiles.sort(), ["added.js", "lib/deep.js"]); // the directory itself is not reported
  });

  test("reports changes Claude Code already staged itself (diffed against HEAD, not the index)", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "app.js"), "console.log('staged');\n");
    git(["add", "app.js"], dir);

    const result = captureGitDiffStat(dir);
    assert.deepEqual(result.changedFiles, ["app.js"]);
  });

  test("excludes gitignored files, which `git add -A` would not commit either", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "secrets.txt\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "ignore secrets"], dir);
    fs.writeFileSync(path.join(dir, "secrets.txt"), "not for git\n");

    const result = captureGitDiffStat(dir);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.newFiles, []);
  });

  test("returns null outside a git repository", () => {
    const dir = tmpDir();
    assert.equal(isGitRepo(dir), false);
    assert.equal(captureGitDiffStat(dir), null);
    assert.equal(captureFullDiff(dir), null);
  });
});

describe("git-info — captureFullDiff", () => {
  test("includes the contents of new files, not just edits to tracked ones", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "app.js"), "console.log('goodbye');\n");
    fs.writeFileSync(path.join(dir, "added.js"), "export const brandNew = true;\n");

    const { diff, truncated } = captureFullDiff(dir);
    assert.equal(truncated, false);
    assert.match(diff, /-console\.log\('hello'\)/); // tracked edit
    assert.match(diff, /\+console\.log\('goodbye'\)/);
    assert.match(diff, /\+export const brandNew = true;/); // new file's contents
    assert.match(diff, /added\.js/);
  });

  test("renders a repository whose only change is a new file (nothing for plain `git diff` to show)", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "only-new.js"), "// nothing else changed\n");

    const { diff } = captureFullDiff(dir);
    assert.match(diff, /only-new\.js/);
    assert.match(diff, /\+\/\/ nothing else changed/);
  });
});
