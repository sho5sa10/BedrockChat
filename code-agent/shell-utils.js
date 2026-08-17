import { spawnSync } from "node:child_process";

/**
 * Shared by any adapter that spawns a Windows .cmd/.bat shim (claude.cmd,
 * npm.cmd, ...) and therefore needs shell:true to launch at all. Node's
 * shell:true concatenates argv into one cmd.exe command line without
 * escaping it (see ClaudeCodeAdapter's docstring for the full story of why
 * that matters) — this quotes a single token defensively. Safe to use
 * uniformly because every caller only ever passes fixed flags, enum
 * values, or paths it resolved itself — never raw user text.
 */
export function quoteForWindowsShell(token) {
  const s = String(token);
  return s === "" || /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * child.kill() alone only signals the immediate child. On Windows, any
 * process spawned with shell:true (see quoteForWindowsShell above) has
 * cmd.exe as that immediate child, with the real process one level further
 * down as *its* child — killing just cmd.exe leaves the real process
 * running, un-cancelled. taskkill /T kills the whole tree. POSIX's plain
 * child.kill() doesn't have this problem (no shell wrapper is used there),
 * so it's left as the direct path. Shared by every spawner in this module
 * that uses shell:true on Windows (ClaudeCodeAdapter, runTests).
 */
export function killProcessTree(child) {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}
