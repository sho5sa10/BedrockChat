import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Answers one question: is the `claude` CLI this app spawns actually routed
 * through Amazon Bedrock?
 *
 * This app never sets CLAUDE_CODE_USE_BEDROCK itself (see
 * code-agent/claude-code.js — it inherits this process's environment
 * verbatim), so the routing decision belongs entirely to however the user
 * configured their CLI. Checking only `process.env` is not enough: the
 * documented and most common way to configure it is the CLI's own
 * settings.json, which start.ps1 / start.sh never load into this process's
 * environment — so a correctly configured machine got warned anyway, and a
 * security warning that cries wolf gets ignored. This reads the same
 * settings files the CLI itself reads. Verified against the installed CLI
 * binary rather than from memory: the settings filenames, CLAUDE_CONFIG_DIR,
 * and the three managed-settings directories below all appear in it.
 *
 * Read-only, local files only — no new network destinations. Never used to
 * *force* routing, only to report what is already configured; the warning
 * this feeds is deliberately not a hard block (see resolveBedrockRouting).
 */

const BEDROCK_ENV_KEY = "CLAUDE_CODE_USE_BEDROCK";

/** The CLI treats "1"/"true" as on; anything else (including absent) as off. */
function isEnabled(value) {
  return /^(1|true)$/i.test(String(value ?? "").trim());
}

/** Enterprise managed policy — the CLI's highest-precedence settings source. */
function managedSettingsDir() {
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

/** Honours CLAUDE_CONFIG_DIR, which relocates the CLI's whole config directory. */
function userSettingsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, "settings.json") : path.join(os.homedir(), ".claude", "settings.json");
}

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // absent or unreadable — indistinguishable, and treated the same
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, "")); // Windows editors add a BOM; JSON.parse rejects it
  } catch {
    return { malformed: true };
  }
}

/**
 * Highest precedence first, mirroring the CLI's own resolution order:
 * enterprise managed policy, then project-local, then project-shared, then
 * the user's own settings. `repoPath` is the directory the CLI will actually
 * run in (the selected Repository), not this app's own checkout — it's
 * optional because /api/config is answered before any Repository is chosen.
 */
function settingsFiles(repoPath, managedDir) {
  const files = [path.join(managedDir ?? managedSettingsDir(), "managed-settings.json")];
  if (repoPath) {
    files.push(path.join(repoPath, ".claude", "settings.local.json"));
    files.push(path.join(repoPath, ".claude", "settings.json"));
  }
  files.push(userSettingsFile());
  return files;
}

/**
 * Returns {enabled, source, detail}:
 *   enabled — true only when Bedrock routing is positively confirmed
 *   source  — "settings" | "env" | null (null = could not confirm either way)
 *   detail  — where the answer came from, so the UI can explain its reasoning
 *
 * Settings files are checked before the inherited environment variable
 * because the CLI applies its settings' `env` block over what it inherits —
 * an explicit "0" in settings would win over an inherited "1".
 *
 * `enabled: false` with `source: null` means "could not confirm", which is
 * NOT the same as "definitely calling Anthropic directly": a wrapper script,
 * a per-invocation flag, or (on Windows) the CLI's registry-based policy
 * source could still route through Bedrock, and none of those are visible
 * from here. That is precisely why the caller warns instead of blocking.
 *
 * `managedSettingsDir` is a test seam only: the real path is machine-wide, so
 * without it a test box that happens to have an enterprise policy installed
 * would change the outcome of the unit tests.
 */
export function resolveBedrockRouting(repoPath, { managedSettingsDir: managedDir } = {}) {
  const unreadable = [];

  for (const file of settingsFiles(repoPath, managedDir)) {
    const settings = readSettings(file);
    if (!settings) continue;
    if (settings.malformed) {
      unreadable.push(file);
      continue;
    }
    const value = settings?.env?.[BEDROCK_ENV_KEY];
    if (value === undefined) continue;
    // An explicit opt-out at a higher-precedence level is deliberate: stop
    // here rather than letting a lower-precedence file re-enable it.
    return isEnabled(value)
      ? { enabled: true, source: "settings", detail: file }
      : { enabled: false, source: "settings", detail: `${file}（明示的に無効化されています）` };
  }

  if (isEnabled(process.env[BEDROCK_ENV_KEY])) {
    return { enabled: true, source: "env", detail: `環境変数 ${BEDROCK_ENV_KEY}` };
  }

  return {
    enabled: false,
    source: null,
    detail: unreadable.length ? `JSONとして読めない設定ファイル: ${unreadable.join(", ")}` : null,
  };
}
