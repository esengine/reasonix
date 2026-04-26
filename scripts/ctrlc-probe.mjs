// Minimal Ctrl+C probe. Usage: node scripts/ctrlc-probe.mjs
// Reproduces the exact stdin setup Reasonix uses, then logs every byte
// it sees and exits on \x03. Tells us whether the OS even delivers
// Ctrl+C to a Node child on this terminal.

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();

console.log("ctrl+c probe armed. press keys; ctrl+c should exit.");
console.log("if ctrl+c does NOT exit, the byte never reaches Node on this terminal.\n");

process.stdin.on("data", (chunk) => {
  const s = String(chunk);
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    process.stdout.write(`got byte: 0x${code.toString(16).padStart(2, "0")} (${JSON.stringify(ch)})\r\n`);
    if (ch === "\x03") {
      process.stdout.write("→ \\x03 detected, exiting.\r\n");
      process.exit(0);
    }
  }
});

process.on("SIGINT", () => {
  process.stdout.write("→ SIGINT received, exiting.\r\n");
  process.exit(0);
});
