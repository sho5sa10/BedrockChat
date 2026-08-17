// Simulates the CLI reporting a structured failure via its final "result"
// line (is_error: true) — e.g. budget exhausted, execution error.
process.stdin.resume();

console.log(JSON.stringify({
  type: "system", subtype: "init",
  session_id: "sess-error-1", model: "claude-sonnet-5", permissionMode: "plan",
}));
console.log(JSON.stringify({
  type: "result", is_error: true,
  subtype: "error_during_execution",
  errors: ["something went wrong"],
  duration_ms: 500,
}));
process.exit(1);
