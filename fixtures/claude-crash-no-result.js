// Simulates the process dying (e.g. crash, kill) before ever emitting a
// "result" line — the adapter must synthesize an error in this case
// instead of silently reporting nothing.
process.stdin.resume();

console.log(JSON.stringify({
  type: "system", subtype: "init",
  session_id: "sess-crash-1", model: "claude-sonnet-5", permissionMode: "plan",
}));
process.stderr.write("fatal: something crashed\n");
process.exit(1);
