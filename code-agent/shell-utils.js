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
