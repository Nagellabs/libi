// Read stdin but never respond — forces probe timeout.
process.stdin.resume();
setInterval(() => {}, 1000);
