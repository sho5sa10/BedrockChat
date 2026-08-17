// Emits a "started" line, then sleeps well past any reasonable test timeout
// before ever producing a result — used to verify ClaudeCodeAdapter.cancel()
// actually kills the process rather than waiting it out.
process.stdin.resume();
console.log(JSON.stringify({
  type: "system", subtype: "init",
  session_id: "sess-slow-1", model: "claude-sonnet-5", permissionMode: "plan",
}));
setTimeout(() => {
  console.log(JSON.stringify({ type: "result", is_error: false, result: "should not be reached in cancel tests", duration_ms: 1, total_cost_usd: 0 }));
  process.exit(0);
}, 30000);
