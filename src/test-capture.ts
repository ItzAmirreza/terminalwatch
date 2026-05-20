// Non-interactive end-to-end smoke test for the data pipeline.
// 1. Lists sessions.
// 2. Picks the first non-self PTY session.
// 3. Attaches via strace for N seconds, with the FD-target filter active.
// 4. Prints the captured bytes (decoded) and exits.
//
// Usage: bun run src/test-capture.ts [seconds]

import { listSessions } from "./sessions.ts";
import { decodeCEscaped, findCloseQuote } from "./cescape.ts";
import { FdResolver } from "./fdfilter.ts";
import { spawn } from "node:child_process";

const seconds = parseInt(process.argv[2] ?? "4", 10);

const sessions = listSessions();
console.log("Discovered sessions:");
for (const s of sessions) {
  console.log(
    `  ${s.user.padEnd(12)} ${s.tty.padEnd(8)} from=${s.from.padEnd(22)} pid=${s.shellPid ?? "?"} fg=${s.foregroundComm ?? "?"} self=${s.isSelf}`,
  );
}
const target = sessions.find((s) => !s.isSelf && s.shellPid);
if (!target) {
  console.error("No watchable session found (need another logged-in user).");
  process.exit(2);
}
console.log(`\nAttaching to ${target.user}@${target.tty} (pid=${target.shellPid}, pts=${target.ttyDev}) for ${seconds}s ...\n`);

const resolver = new FdResolver(target.ttyDev, true);
const collected: Buffer[] = [];
const dropped = { lines: 0, bytes: 0 };
let kept = 0;
const decisions = new Map<string, { kept: boolean; bytes: number; firstSample: string }>();

const child = spawn(
  "sudo",
  [
    "-n", "strace",
    "-f",
    "-p", String(target.shellPid),
    "-e", "trace=write",
    "-e", "signal=none",
    "-s", "65535",
    "-qq",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let lineBuf = "";
let nonTraceLines: string[] = [];
child.stderr!.on("data", (buf: Buffer) => {
  lineBuf += buf.toString("binary");
  let nl: number;
  while ((nl = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, nl);
    lineBuf = lineBuf.slice(nl + 1);
    handleLine(line);
  }
});

function handleLine(line: string) {
  let i = 0;
  let pid = target!.shellPid!;
  if (line.startsWith("[pid")) {
    const close = line.indexOf("]", 4);
    if (close < 0) return;
    pid = parseInt(line.slice(4, close).trim(), 10);
    i = close + 1;
    while (i < line.length && line.charCodeAt(i) === 0x20) i++;
  }
  if (!line.startsWith("write(", i)) {
    if (line.startsWith("strace:")) nonTraceLines.push(line);
    return;
  }
  i += "write(".length;
  const comma = line.indexOf(",", i);
  if (comma < 0) return;
  const fd = parseInt(line.slice(i, comma).trim(), 10);
  const isTty = resolver.isTargetTty(pid, fd);
  let j = comma + 1;
  while (j < line.length && line.charCodeAt(j) === 0x20) j++;
  if (line.charCodeAt(j) !== 0x22) return;
  const close = findCloseQuote(line, j + 1);
  if (close < 0) return;
  const bytes = decodeCEscaped(line.slice(j + 1, close));
  const key = `${pid}:${fd}`;
  let d = decisions.get(key);
  if (!d) {
    d = { kept: isTty, bytes: 0, firstSample: Buffer.from(bytes).toString("utf8").slice(0, 60).replace(/[\x00-\x1f]/g, "·") };
    decisions.set(key, d);
  }
  d.bytes += bytes.length;
  if (isTty) {
    collected.push(Buffer.from(bytes));
    kept += bytes.length;
  } else {
    dropped.lines += 1;
    dropped.bytes += bytes.length;
  }
}

setTimeout(() => child.kill("SIGTERM"), seconds * 1000);

child.on("exit", () => {
  const merged = Buffer.concat(collected);
  console.log(`\n--- kept ${kept} bytes (tty writes) · dropped ${dropped.bytes} bytes across ${dropped.lines} non-tty write() lines ---`);
  if (nonTraceLines.length) {
    console.log("strace messages:\n  " + nonTraceLines.slice(0, 5).join("\n  "));
  }
  // Uncomment for per-(pid,fd) decision tracing:
  // const rows = [...decisions.entries()].sort(([, a], [, b]) => b.bytes - a.bytes);
  // for (const [key, d] of rows.slice(0, 30)) {
  //   console.log(`  ${d.kept ? "KEEP" : "drop"} ${key.padEnd(12)} ${String(d.bytes).padStart(7)}B  sample="${d.firstSample}"`);
  // }
  void decisions;
  console.log("\n=== DECODED OUTPUT (what the target user is seeing) ===");
  process.stdout.write(merged);
  console.log("\n=== END ===");
  process.exit(0);
});
