import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildChildEnv } from "../code-agent/claude-code.js";

/**
 * The environment handed to the spawned `claude` CLI is what makes Claude
 * Desk's "only talks to Bedrock and a local CLI" claim enforceable rather
 * than aspirational. Until v1.6.4 the child simply inherited this process's
 * environment, so an unconfigured machine reached Anthropic's API directly
 * and even a Bedrock-routed one still did update checks and telemetry.
 * These pin that down so it cannot regress into inheritance again.
 */
describe("claude-code — buildChildEnv", () => {
  test("forces Bedrock routing and disables non-essential traffic", () => {
    const env = buildChildEnv({ PATH: "/usr/bin" });
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  });

  test("passes the rest of the environment through untouched", () => {
    // AWS credentials/region and the proxy + CA settings all reach the CLI
    // this way; dropping them would break the very setup this app targets.
    const env = buildChildEnv({
      AWS_PROFILE: "bedrock",
      AWS_REGION: "ap-northeast-1",
      HTTPS_PROXY: "http://proxy.example.co.jp:8080",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\root.pem",
    });
    assert.equal(env.AWS_PROFILE, "bedrock");
    assert.equal(env.AWS_REGION, "ap-northeast-1");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example.co.jp:8080");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "C:\\certs\\root.pem");
  });

  test("ALLOW_ANTHROPIC_DIRECT=1 opts out of both", () => {
    const env = buildChildEnv({ ALLOW_ANTHROPIC_DIRECT: "1", PATH: "/usr/bin" });
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
    assert.equal(env.PATH, "/usr/bin");
  });

  test("only 1/true opt out — anything else keeps the enforcement", () => {
    for (const value of ["0", "false", "no", "", "yes"]) {
      const env = buildChildEnv({ ALLOW_ANTHROPIC_DIRECT: value });
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1", `ALLOW_ANTHROPIC_DIRECT=${JSON.stringify(value)}`);
    }
  });

  test("an opted-out run keeps whatever the environment already said", () => {
    // Someone who deliberately opts out may still have configured the CLI
    // themselves; opting out must not also erase their own settings.
    const env = buildChildEnv({ ALLOW_ANTHROPIC_DIRECT: "1", CLAUDE_CODE_USE_BEDROCK: "1" });
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
  });

  test("does not mutate the environment object it was given", () => {
    const original = { PATH: "/usr/bin" };
    buildChildEnv(original);
    assert.equal(original.CLAUDE_CODE_USE_BEDROCK, undefined);
  });
});
