import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectTestCommand, runTests } from "../code-agent/test-runner.js";

function tmpDir(prefix = "bedrockchat-testrunner-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("test-runner — detectTestCommand (file presence only, never file contents)", () => {
  test("detects npm test from package.json when scripts.test is a real command", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.deepEqual(detectTestCommand(dir), { command: "npm", args: ["test"], label: "npm test" });
  });

  test("ignores package.json's default placeholder test script", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    assert.equal(detectTestCommand(dir), null);
  });

  test("detects pytest from pytest.ini", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "pytest.ini"), "[pytest]\n");
    assert.deepEqual(detectTestCommand(dir), { command: "pytest", args: [], label: "pytest" });
  });

  test("detects go test from go.mod", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n");
    assert.deepEqual(detectTestCommand(dir), { command: "go", args: ["test", "./..."], label: "go test ./..." });
  });

  test("detects mvn test from pom.xml", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project></project>");
    assert.deepEqual(detectTestCommand(dir), { command: "mvn", args: ["test"], label: "mvn test" });
  });

  test("returns null for a repository with no recognized project files", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "README.md"), "just a readme\n");
    assert.equal(detectTestCommand(dir), null);
  });
});

describe("test-runner — runTests (real subprocess, no fixtures needed: node itself is the 'test tool')", () => {
  test("ran:false with a clear reason when no test command is detected", async () => {
    const dir = tmpDir();
    const result = await runTests(dir);
    assert.equal(result.ran, false);
    assert.match(result.reason, /no recognized test command/);
  });

  test("runs a real passing command end to end and reports passed:true", async () => {
    // npm is guaranteed present (it's how this test suite itself runs);
    // node -e "process.exit(0)" as the "test" script keeps this fast and
    // dependency-free while still exercising a real spawned subprocess.
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const result = await runTests(dir);
    assert.equal(result.ran, true);
    assert.equal(result.label, "npm test");
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
  });

  test("captures failing output and reports passed:false", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.error('boom'); process.exit(1)\"" } }));
    const result = await runTests(dir);
    assert.equal(result.ran, true);
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /boom/);
  });

  test("ran:false when the detected command itself is not on PATH", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project></project>"); // -> mvn, almost certainly absent from a Node test box
    const result = await runTests(dir);
    if (result.ran) return; // mvn happens to be installed in this environment — nothing to assert
    assert.match(result.reason, /not found on PATH/);
  });
});
