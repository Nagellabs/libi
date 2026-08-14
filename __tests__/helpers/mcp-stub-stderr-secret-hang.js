// Like mcp-stub-stderr-secret.js, but hangs after writing the secret to stderr
// so the probe hits its timeout path (exercises the `timeout` warn log site).
const secret = process.env.LEAK_SENTINEL || "";
process.stderr.write(`auth failed 401: token=${secret}\n`);
process.stdin.resume();
setInterval(() => {}, 1000);
