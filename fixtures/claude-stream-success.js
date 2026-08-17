// Stand-in for `claude -p --output-format stream-json`, used by code-agent
// tests to verify event normalization without invoking the real CLI (no
// network, no cost). Shape is modeled on real 2.1.222 output captured
// during Phase 1 verification.
process.stdin.resume();

console.log(JSON.stringify({
  type: "system", subtype: "init",
  session_id: "sess-success-1", model: "claude-sonnet-5", permissionMode: "plan",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Investigating the repository..." }] },
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/foo.js" } }] },
}));
console.log(JSON.stringify({
  type: "result", is_error: false,
  result: "Done: added a helper function.",
  duration_ms: 1234, num_turns: 3, total_cost_usd: 0.01,
  usage: { input_tokens: 120, output_tokens: 340, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
}));
process.exit(0);
