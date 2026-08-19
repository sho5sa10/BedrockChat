import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveBedrockRouting } from "../code-agent/cli-config.js";

function tmpDir(prefix = "claude-desk-cliconfig-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Always neutralise the machine-wide enterprise policy file: on a PC that
// actually has one installed it would otherwise decide these tests' outcome.
let emptyManagedDir;
function resolve(repoPath) {
  return resolveBedrockRouting(repoPath, { managedSettingsDir: emptyManagedDir });
}

/** Writes a CLI settings.json into <dir>/.claude/ (project layout). */
function writeProjectSettings(repo, name, settings) {
  const dir = path.join(repo, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof settings === "string" ? settings : JSON.stringify(settings));
}

/**
 * These pin down the behaviour the warning depends on. The bug being guarded
 * against: reading only process.env made a machine configured the documented
 * way — the CLI's own settings.json — look unconfigured, so correctly set up
 * users got a security warning telling them they might be sending code to the
 * wrong place. A warning that fires on correct setups gets dismissed reflexively.
 *
 * CLAUDE_CONFIG_DIR is used to redirect "user-level settings" into a temp dir,
 * so no test ever reads or writes the real ~/.claude/settings.json.
 */
describe("cli-config — resolveBedrockRouting", () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k];
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    // Point user-level settings at an empty dir so the developer's own
    // ~/.claude/settings.json can't make these tests pass or fail.
    process.env.CLAUDE_CONFIG_DIR = tmpDir("claude-desk-cfgdir-");
    emptyManagedDir = tmpDir("claude-desk-managed-");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Resolve with the enforcement opted out of, which is the only way the
   *  inherited-environment branch is reachable at all since v1.6.4. */
  function resolveOptedOut(repoPath, extraEnv = {}) {
    return resolveBedrockRouting(repoPath, {
      managedSettingsDir: emptyManagedDir,
      env: { ALLOW_ANTHROPIC_DIRECT: "1", ...extraEnv },
    });
  }

  test("enforced by this app when nothing else decides it", () => {
    const result = resolve(tmpDir());
    assert.equal(result.enabled, true);
    assert.equal(result.source, "enforced");
  });

  test("cannot be confirmed once the enforcement is opted out of", () => {
    const result = resolveOptedOut(tmpDir());
    assert.equal(result.enabled, false);
    assert.equal(result.source, null);
  });

  test("falls back to the inherited environment variable when opted out", () => {
    const result = resolveOptedOut(tmpDir(), { CLAUDE_CODE_USE_BEDROCK: "1" });
    assert.equal(result.enabled, true);
    assert.equal(result.source, "env");
  });

  test('accepts "true" as well as "1", and rejects other values', () => {
    const enabledFor = (v) => resolveOptedOut(tmpDir(), { CLAUDE_CODE_USE_BEDROCK: v }).enabled;
    assert.equal(enabledFor("true"), true);
    assert.equal(enabledFor("1"), true);
    assert.equal(enabledFor("yes"), false);
    assert.equal(enabledFor("0"), false);
  });

  // The precedence caveat the enforcement rests on: the CLI applies a
  // settings file's `env` over what it inherits, so an explicit off there
  // beats the value this app forces. Claiming Bedrock routing in that case
  // would be exactly the kind of false reassurance this module exists to avoid.
  test("an explicit off in settings still wins over the app's enforcement", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", { env: { CLAUDE_CODE_USE_BEDROCK: "0" } });
    const result = resolve(repo);
    assert.equal(result.enabled, false);
    assert.equal(result.source, "settings");
  });

  // The regression this whole module exists for.
  test("confirmed from the user's own settings.json, with no environment variable set", () => {
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "ap-northeast-1" } })
    );
    const result = resolve(tmpDir());
    assert.equal(result.enabled, true);
    assert.equal(result.source, "settings");
    assert.match(result.detail, /settings\.json$/);
  });

  test("confirmed from the selected Repository's own .claude/settings.json", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    const result = resolve(repo);
    assert.equal(result.enabled, true);
    assert.equal(result.source, "settings");
  });

  test("settings.local.json outranks settings.json in the same Repository", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    writeProjectSettings(repo, "settings.local.json", { env: { CLAUDE_CODE_USE_BEDROCK: "0" } });

    const result = resolve(repo);
    assert.equal(result.enabled, false);
    assert.equal(result.source, "settings"); // explicitly off, not merely unconfirmed
    assert.match(result.detail, /settings\.local\.json/);
  });

  test("an explicit off in the Repository is not re-enabled by the user's settings", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", { env: { CLAUDE_CODE_USE_BEDROCK: "false" } });
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })
    );
    const result = resolve(repo);
    assert.equal(result.enabled, false);
    assert.equal(result.source, "settings");
  });

  test("settings files win over an inherited environment variable, since the CLI applies them over it", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", { env: { CLAUDE_CODE_USE_BEDROCK: "0" } });
    assert.equal(resolve(repo).enabled, false);
  });

  test("a settings file that does not mention the key is skipped, not treated as off", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", { model: "global.anthropic.claude-opus-5", env: { AWS_PROFILE: "x" } });
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })
    );
    const result = resolve(repo);
    assert.equal(result.enabled, true); // fell through to the user-level file
    assert.equal(result.source, "settings");
  });

  test("malformed JSON is reported rather than crashing or being read as confirmation", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", "{ this is not json");
    // Enforcement still answers "routed through Bedrock", but the file we
    // could not parse has to stay visible — the CLI may read it differently.
    const result = resolve(repo);
    assert.equal(result.source, "enforced");
    assert.match(result.detail, /読めない/);
    // ...and with enforcement off there is nothing left to confirm it.
    const optedOut = resolveOptedOut(repo);
    assert.equal(optedOut.enabled, false);
    assert.equal(optedOut.source, null);
    assert.match(optedOut.detail, /読めない/);
  });

  test("tolerates a UTF-8 BOM, which Windows editors add and JSON.parse rejects", () => {
    const repo = tmpDir();
    writeProjectSettings(repo, "settings.json", "\uFEFF" + JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
    assert.equal(resolve(repo).enabled, true);
  });

  test("works with no Repository selected, which is how /api/config calls it", () => {
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })
    );
    const result = resolve();
    assert.equal(result.enabled, true);
    assert.equal(result.source, "settings");
  });
});
