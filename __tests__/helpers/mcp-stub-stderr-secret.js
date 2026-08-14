// Simulates an MCP child that echoes a configured secret in an error body on
// stderr (e.g. a 401 reflecting the Authorization header), then exits before
// completing `initialize`. The sentinel value is passed via LEAK_SENTINEL so
// the test can assert it never reaches the logs. Exercises the stderr-chunk
// trace + exit_before_init warn + complete info log sites.
const secret = process.env.LEAK_SENTINEL || "";
process.stderr.write(`auth failed 401: token=${secret}\n`);
process.exit(1);
