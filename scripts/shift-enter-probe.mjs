// Shift+Enter probe. Usage: node scripts/shift-enter-probe.mjs
// Enables modifyOtherKeys + kitty keyboard protocol, then prints the
// raw bytes for every keypress. Press Shift+Enter and see what your
// terminal actually emits — if it's just "0x0d", the host doesn't
// support either protocol and there's nothing Reasonix can do at the
// raw-stdin layer.

process.stdout.write("\u001b[>4;2m"); // modifyOtherKeys level 2 (xterm)
process.stdout.write("\u001b[>1u"); // kitty keyboard protocol level 1

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();

console.log("shift+enter probe armed. press keys; ctrl+c exits.");
console.log("expected for shift+enter:");
console.log("  modifyOtherKeys → 0x1b 0x5b 0x32 0x37 0x3b 0x32 0x3b 0x31 0x33 0x7e  (\\x1b[27;2;13~)");
console.log("  kitty           → 0x1b 0x5b 0x31 0x33 0x3b 0x32 0x75              (\\x1b[13;2u)");
console.log("  unsupported     → 0x0d                                              (just \\r — no way to distinguish)\n");

process.stdin.on("data", (chunk) => {
  const s = String(chunk);
  const bytes = [...s].map((c) => `0x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(" ");
  process.stdout.write(`got: ${bytes}    (${JSON.stringify(s)})\r\n`);
  if (s.includes("\x03")) {
    process.stdout.write("\u001b[>4m"); // disable modifyOtherKeys
    process.stdout.write("\u001b[<u"); // pop kitty level
    process.exit(0);
  }
});
