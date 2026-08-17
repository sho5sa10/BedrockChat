import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { quoteForWindowsShell } from "./shell-utils.js";

const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Detects a test command from well-known project files only — the detected
 * {command, args} always comes from this fixed table, never from file
 * *contents*, so there is no path by which a repository's own files could
 * inject an arbitrary command. This is deliberately not a general "run
 * whatever command the user or Claude Code asks for" facility.
 */
export function detectTestCommand(repoPath) {
  const has = (name) => fs.existsSync(path.join(repoPath, name));

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf8"));
      const script = pkg?.scripts?.test;
      if (script && !/no test specified/i.test(script)) {
        return { command: "npm", args: ["test"], label: "npm test" };
      }
    } catch {
      // malformed package.json — fall through to other detectors
    }
  }
  if (has("pytest.ini") || has("conftest.py") || has("pyproject.toml") || has("setup.cfg")) {
    return { command: "pytest", args: [], label: "pytest" };
  }
  if (has("go.mod")) {
    return { command: "go", args: ["test", "./..."], label: "go test ./..." };
  }
  if (has("pom.xml")) {
    return { command: "mvn", args: ["test"], label: "mvn test" };
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    const gradlew = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    return has(gradlew) ? { command: `./${gradlew}`, args: ["test"], label: `${gradlew} test` } : { command: "gradle", args: ["test"], label: "gradle test" };
  }
  if (has("Cargo.toml")) {
    return { command: "cargo", args: ["test"], label: "cargo test" };
  }
  return null;
}

function isCommandAvailable(command) {
  if (command.includes("/") || command.includes("\\")) return fs.existsSync(command);
  const finder = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(finder, [command], { windowsHide: true });
  if (probe.error) return true; // finder itself unavailable: fail open, let spawn decide
  return probe.status === 0;
}

/**
 * Runs the detected test command, if any. Never runs arbitrary shell text —
 * only ever the fixed {command, args} detectTestCommand() returned. Returns
 * {ran:false, reason} when no recognized project/test setup was found,
 * rather than guessing or falling back to a shell.
 *
 * Async and spawn-based rather than spawnSync: a test suite can run for
 * minutes, and spawnSync blocks Node's single event loop for its entire
 * duration — which would freeze every other session's chat/SSE traffic on
 * this server, not just the one waiting on its tests.
 */
export function runTests(repoPath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const detected = detectTestCommand(repoPath);
  if (!detected) return Promise.resolve({ ran: false, reason: "no recognized test command for this repository" });

  if (!isCommandAvailable(detected.command)) {
    return Promise.resolve({ ran: false, reason: `"${detected.command}" was not found on PATH`, label: detected.label });
  }

  const useShell = process.platform === "win32";
  const spawnCommand = useShell ? quoteForWindowsShell(detected.command) : detected.command;
  const spawnArgs = useShell ? detected.args.map(quoteForWindowsShell) : detected.args;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd: repoPath,
        shell: useShell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ran: false, reason: err.message, label: detected.label });
      return;
    }

    const chunks = [];
    let byteLen = 0;
    const collect = (d) => {
      if (byteLen < MAX_OUTPUT_BYTES) { chunks.push(d); byteLen += d.length; }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ran: false, reason: err.message, label: detected.label });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const combined = Buffer.concat(chunks).toString("utf8").trim();
      const truncated = Buffer.byteLength(combined, "utf8") >= MAX_OUTPUT_BYTES;
      resolve({
        ran: true,
        label: detected.label,
        passed: !timedOut && code === 0,
        exitCode: code,
        timedOut,
        output: truncated ? combined.slice(0, MAX_OUTPUT_BYTES) + "\n… (truncated)" : combined,
      });
    });
  });
}
