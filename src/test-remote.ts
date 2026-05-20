// Smoke test for SshTransport: list sessions on a remote host.
//
// Usage: bun run src/test-remote.ts <user@host> [-i KEY] [-p PORT]

import { listSessions } from "./sessions.ts";
import { fetchHistory } from "./history.ts";
import { SshTransport } from "./transport.ts";

const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0]!.startsWith("-")) {
  console.error("usage: bun run src/test-remote.ts <user@host> [-i KEY] [-p PORT]");
  process.exit(2);
}
const target = argv[0]!;
const extra: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "-i" || a === "-p" || a === "-o") {
    extra.push(a, argv[++i]!);
  }
}

const t = new SshTransport({ target, extraArgs: extra });
console.log(`opening control socket to ${target} ...`);
t.open();

const start = Date.now();
const sessions = listSessions(t);
console.log(`listSessions: ${sessions.length} session(s) in ${Date.now() - start}ms`);
for (const s of sessions) {
  console.log(
    `  ${s.user.padEnd(12)} ${s.tty.padEnd(8)} from=${s.from.padEnd(22)} pid=${String(s.shellPid ?? "?").padEnd(6)} fg=${s.foregroundComm ?? "?"} self=${s.isSelf} idle=${s.idle}`,
  );
}

// Prefer the most recently active session for the attach demo
// (older idle sessions tend to be stale leftovers from prior tests).
const candidates = sessions.filter((s) => !s.isSelf && s.shellPid);
const watchable =
  candidates.find((s) => s.idle === "." && s.foregroundComm !== "sudo") ??
  candidates.find((s) => s.idle === ".") ??
  candidates[candidates.length - 1];
if (watchable) {
  const hist = fetchHistory(t, watchable.user, 5, "operator-not-resolved");
  console.log(`\nhistory tail for ${watchable.user}:`);
  for (const cmd of hist.entries) console.log(`  $ ${cmd}`);

  console.log(`\nattaching remote strace for 6s to ${watchable.user}@${watchable.tty} (pid ${watchable.shellPid}) ...`);
  const { FdResolver } = await import("./fdfilter.ts");
  const { decodeCEscaped, findCloseQuote } = await import("./cescape.ts");
  const resolver = new FdResolver(watchable.ttyDev, t, true);

  const child = t.spawnPipe(
    [
      "sudo", "-n", "strace",
      "-f", "-p", String(watchable.shellPid),
      "-e", "trace=write", "-e", "signal=none",
      "-s", "65535", "-qq",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let kept = 0;
  let droppedBytes = 0;
  const collected: Buffer[] = [];
  let lineBuf = "";
  child.stderr!.on("data", (buf: Buffer) => {
    lineBuf += buf.toString("binary");
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      let i = 0;
      let pid = watchable.shellPid!;
      if (line.startsWith("[pid")) {
        const close = line.indexOf("]", 4);
        if (close < 0) continue;
        pid = parseInt(line.slice(4, close).trim(), 10);
        i = close + 1;
        while (i < line.length && line.charCodeAt(i) === 0x20) i++;
      }
      if (!line.startsWith("write(", i)) continue;
      i += "write(".length;
      const comma = line.indexOf(",", i);
      if (comma < 0) continue;
      const fd = parseInt(line.slice(i, comma).trim(), 10);
      const ok = resolver.isTargetTty(pid, fd);
      let j = comma + 1;
      while (j < line.length && line.charCodeAt(j) === 0x20) j++;
      if (line.charCodeAt(j) !== 0x22) continue;
      const closeq = findCloseQuote(line, j + 1);
      if (closeq < 0) continue;
      const bytes = decodeCEscaped(line.slice(j + 1, closeq));
      if (ok) { collected.push(Buffer.from(bytes)); kept += bytes.length; }
      else droppedBytes += bytes.length;
    }
  });
  await new Promise((r) => setTimeout(r, 6000));
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((r) => child.on("exit", r)),
    new Promise((r) => setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(undefined); }, 2000)),
  ]);
  console.log(`kept ${kept}B, dropped ${droppedBytes}B`);
  console.log("--- decoded output ---");
  process.stdout.write(Buffer.concat(collected));
  console.log("\n--- end ---");
}

t.close();
console.log("\nclosed.");
