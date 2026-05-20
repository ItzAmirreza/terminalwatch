// Diagnostic: list every (pid, fd) we see writing during the capture,
// what each fd's symlink resolves to, and a sample of the data written.
// This lets us understand what the filter is dropping and why.
//
// Usage: bun run src/test-diag.ts [seconds]

import { listSessions } from "./sessions.ts";
import { decodeCEscaped, findCloseQuote } from "./cescape.ts";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

const seconds = parseInt(process.argv[2] ?? "8", 10);

const target = listSessions().find((s) => !s.isSelf && s.shellPid);
if (!target) {
  console.error("No watchable session.");
  process.exit(2);
}
console.log(`target ${target.user}@${target.tty} pid=${target.shellPid} pts=${target.ttyDev}\n`);

type Sample = { pid: number; fd: number; link: string | null; ctty: string | null; bytes: number; sample: string };
const seen = new Map<string, Sample>();

function readCtty(pid: number): string | null {
  let stat: string | null = null;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch {
    const r = spawnSync("sudo", ["-n", "cat", `/proc/${pid}/stat`], { encoding: "utf8" });
    if (r.status === 0) stat = r.stdout;
  }
  if (!stat) return null;
  const rp = stat.lastIndexOf(")");
  const tail = stat.slice(rp + 2).split(" ");
  const ttyNr = parseInt(tail[4] ?? "0", 10);
  if (!ttyNr) return "(no ctty)";
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  if (major >= 136 && major <= 143) return `/dev/pts/${minor}`;
  return `dev(${major},${minor})`;
}

const child = spawn(
  "sudo",
  ["-n", "strace", "-f", "-p", String(target.shellPid),
   "-e", "trace=write", "-e", "signal=none", "-s", "200", "-qq"],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let buf = "";
child.stderr!.on("data", (b: Buffer) => {
  buf += b.toString("binary");
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    handleLine(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
});

function resolveLink(pid: number, fd: number): string | null {
  try { return readlinkSync(`/proc/${pid}/fd/${fd}`); }
  catch {}
  const r = spawnSync("sudo", ["-n", "readlink", `/proc/${pid}/fd/${fd}`], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function handleLine(line: string) {
  let i = 0;
  let pid = target!.shellPid!;
  if (line.startsWith("[pid")) {
    const c = line.indexOf("]", 4);
    if (c < 0) return;
    pid = parseInt(line.slice(4, c).trim(), 10);
    i = c + 1;
    while (i < line.length && line.charCodeAt(i) === 0x20) i++;
  }
  if (!line.startsWith("write(", i)) return;
  i += "write(".length;
  const comma = line.indexOf(",", i);
  if (comma < 0) return;
  const fd = parseInt(line.slice(i, comma).trim(), 10);
  let j = comma + 1;
  while (j < line.length && line.charCodeAt(j) === 0x20) j++;
  if (line.charCodeAt(j) !== 0x22) return;
  const close = findCloseQuote(line, j + 1);
  if (close < 0) return;
  const bytes = decodeCEscaped(line.slice(j + 1, close));
  const key = `${pid}:${fd}`;
  let s = seen.get(key);
  if (!s) {
    s = {
      pid, fd,
      link: resolveLink(pid, fd),
      ctty: readCtty(pid),
      bytes: 0,
      sample: Buffer.from(bytes).toString("utf8").slice(0, 80).replace(/[\x00-\x1f]/g, "·"),
    };
    seen.set(key, s);
  }
  s.bytes += bytes.length;
}

setTimeout(() => child.kill("SIGTERM"), seconds * 1000);
child.on("exit", () => {
  console.log("UNIQUE (PID, FD) → LINK · TOTAL_BYTES");
  console.log("---");
  const rows = [...seen.values()].sort((a, b) => b.bytes - a.bytes);
  for (const r of rows) {
    const lk = r.link ?? "(unreadable)";
    const ct = r.ctty ?? "(?)";
    console.log(`pid=${String(r.pid).padEnd(7)} fd=${String(r.fd).padEnd(3)} ctty=${ct.padEnd(12)} bytes=${String(r.bytes).padEnd(7)} link=${lk.padEnd(20)} sample="${r.sample}"`);
  }
  process.exit(0);
});
