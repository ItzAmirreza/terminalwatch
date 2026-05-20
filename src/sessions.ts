// Session discovery: list logged-in PTY sessions on the local host.
// We parse `who` for the basic list, then enrich each row with the active
// shell PID (from /proc) and the foreground command (from `ps`).
//
// On Linux this reads /proc and runs `who`. On non-Linux we fall back to
// `--mock` style synthetic data so the UI can be developed on macOS.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { platform, hostname, userInfo } from "node:os";

export type Session = {
  user: string;
  tty: string;          // e.g. "pts/0"
  ttyDev: string;       // e.g. "/dev/pts/0"
  from: string;         // remote host/IP if known
  loginAt: string;      // raw login time string from `who`
  idle: string;         // e.g. "00:05" or "."
  shellPid: number | null;
  foregroundPid: number | null;
  foregroundComm: string | null;
  isSelf: boolean;
};

const MOCK = process.env.TWATCH_MOCK === "1" || process.argv.includes("--mock");

export function isLinux(): boolean {
  return platform() === "linux";
}

export function listSessions(): Session[] {
  if (MOCK || !isLinux()) return mockSessions();
  const who = runWho();
  const selfTty = selfTtyName();
  const sessions: Session[] = [];
  for (const row of who) {
    const ttyDev = `/dev/${row.tty}`;
    const { shellPid, foregroundPid, foregroundComm } = ptyOwners(row.tty);
    sessions.push({
      user: row.user,
      tty: row.tty,
      ttyDev,
      from: row.from,
      loginAt: row.loginAt,
      idle: ttyIdle(ttyDev),
      shellPid,
      foregroundPid,
      foregroundComm,
      isSelf: selfTty === row.tty,
    });
  }
  return sessions;
}

export function hostLabel(): string {
  return `${userInfo().username}@${hostname()}`;
}

type WhoRow = { user: string; tty: string; loginAt: string; from: string };

function runWho(): WhoRow[] {
  // `who -H` includes headers; we skip lines that don't have a tty starting with pts/ or tty
  const r = spawnSync("who", [], { encoding: "utf8" });
  if (r.status !== 0) return [];
  const rows: WhoRow[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    // who output columns: USER TTY LOGINDATE LOGINTIME (FROM)
    // e.g. "azureuser pts/0        2026-05-20 20:35 (77.119.164.236)"
    const m = line.match(/^(\S+)\s+(pts\/\d+|tty\S+)\s+(.+?)(?:\s+\(([^)]*)\))?\s*$/);
    if (!m) continue;
    rows.push({
      user: m[1]!,
      tty: m[2]!,
      loginAt: m[3]!.trim(),
      from: m[4] ?? "local",
    });
  }
  return rows;
}

function selfTtyName(): string | null {
  const sshTty = process.env.SSH_TTY; // e.g. /dev/pts/3
  if (sshTty && sshTty.startsWith("/dev/")) return sshTty.slice(5);
  try {
    const r = spawnSync("tty", [], { encoding: "utf8" });
    if (r.status === 0) {
      const t = r.stdout.trim();
      if (t.startsWith("/dev/")) return t.slice(5);
    }
  } catch {}
  return null;
}

function ttyIdle(ttyDev: string): string {
  try {
    const s = statSync(ttyDev);
    const mins = Math.floor((Date.now() - s.atimeMs) / 60_000);
    if (mins < 1) return ".";
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    return `${h}h${mins % 60}m`;
  } catch {
    return "?";
  }
}

// For a given pts (e.g. "pts/0"), find:
//   shellPid       — the session leader (login shell) on that tty
//   foregroundPid  — the process group leader currently in foreground
//   foregroundComm — its comm name (e.g. "vim", "bash", "top")
//
// We use `ps -e` instead of walking /proc/PID/fd. That used to require
// the listing process to own each fd we readlinked, which silently
// excluded cross-user sessions. `ps` reads /proc/PID/stat (world-readable
// by default) and reports the controlling tty + STAT flags we need, so
// the same call works whether the logged-in user is us or someone else.
function ptyOwners(tty: string): {
  shellPid: number | null;
  foregroundPid: number | null;
  foregroundComm: string | null;
} {
  // ps -e: every process
  //    -o pid=,tty=,stat=,comm=  : just these columns, no header
  // STAT codes (see ps(1)):
  //    's' suffix = session leader
  //    '+' suffix = process in the foreground process group of its tty
  const r = spawnSync(
    "ps",
    ["-e", "-o", "pid=,tty=,stat=,comm="],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return { shellPid: null, foregroundPid: null, foregroundComm: null };

  let leader: { pid: number; comm: string } | null = null;
  let foreground: { pid: number; comm: string } | null = null;

  for (const raw of r.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pidStr, procTty, stat, comm] = m;
    if (procTty !== tty) continue;
    const pid = parseInt(pidStr!, 10);
    if (stat!.includes("s") && !leader) leader = { pid, comm: comm! };
    if (stat!.includes("+")) foreground = { pid, comm: comm! };
  }

  return {
    shellPid: leader?.pid ?? null,
    foregroundPid: foreground?.pid ?? leader?.pid ?? null,
    foregroundComm: foreground?.comm ?? leader?.comm ?? null,
  };
}

function mockSessions(): Session[] {
  return [
    {
      user: "azureuser",
      tty: "pts/0",
      ttyDev: "/dev/pts/0",
      from: "77.119.164.236",
      loginAt: "2026-05-20 20:35",
      idle: ".",
      shellPid: 4054,
      foregroundPid: 4054,
      foregroundComm: "bash",
      isSelf: false,
    },
    {
      user: "azureuser",
      tty: "pts/1",
      ttyDev: "/dev/pts/1",
      from: "(self)",
      loginAt: "2026-05-20 20:42",
      idle: ".",
      shellPid: 9999,
      foregroundPid: 9999,
      foregroundComm: "bash",
      isSelf: true,
    },
    {
      user: "deploy",
      tty: "pts/2",
      ttyDev: "/dev/pts/2",
      from: "10.0.0.7",
      loginAt: "2026-05-20 20:40",
      idle: "3m",
      shellPid: 5120,
      foregroundPid: 5180,
      foregroundComm: "vim",
      isSelf: false,
    },
  ];
}
