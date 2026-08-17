// Stand-in for `claude -p [--resume <id>] --output-format stream-json`. Used
// to verify CodeSessionManager's multi-turn behavior end to end: it emits a
// "started" event carrying a session_id derived from whether --resume was
// passed (so tests can assert the adapter forwarded resumeSessionId
// correctly), then a text event and a successful result.
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const resumedFrom = resumeIdx >= 0 ? args[resumeIdx + 1] : null;

process.stdin.resume();
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const sessionId = resumedFrom || "sess-fresh-1";
  console.log(JSON.stringify({
    type: "system", subtype: "init",
    session_id: sessionId, model: "claude-sonnet-5", permissionMode: "plan",
  }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: `echo:${input}${resumedFrom ? ` (resumed:${resumedFrom})` : ""}` }] },
  }));
  console.log(JSON.stringify({
    type: "result", is_error: false, result: "ok", duration_ms: 10, num_turns: 1, total_cost_usd: 0.001,
  }));
  process.exit(0);
});
