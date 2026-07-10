// Session discovery: list logged-in PTY sessions on the host pointed to
// by the Transport. For LocalTransport this reads the operator's own
// kernel; for SshTransport it shells out to the remote box.
//
// Two orchestrators are exported:
//   - listSessions()      — synchronous; used by the dev smoke tests.
//   - listSessionsAsync() — non-blocking; used by the live TUI so an SSH
//                           round-trip on the 3s refresh can't freeze the
//                           OpenTUI render loop.
// They share the parse/format helpers below so they can't drift apart.

import { statSync } from "node:fs";
import { hostname, platform, userInfo } from "node:os";
import type { Transport } from "./transport.ts";

export type Session = {
  user: string;
  tty: string;          // e.g. "pts/0"
  ttyDev: string;       // e.g. "/dev/pts/0"
  from: string;         // remote host/IP if known
  loginAt: string;      // raw login time string from `who`
  idle: string;         // e.g. "5m" or "."
  shellPid: number | null;
  foregroundPid: number | null;
  foregroundComm: string | null;
  isSelf: boolean;
};

const MOCK = process.env.TWATCH_MOCK === "1" || process.argv.includes("--mock");

export function isLinux(): boolean {
  return platform() === "linux";
}

export function listSessions(transport: Transport): Session[] {
  if (MOCK) return mockSessions();
  if (transport.isLocal() && !isLinux()) return [];

  const who = parseWho(runText(transport.execCapture(["who"])));
  const selfTty = transport.isLocal() ? selfTtyName(transport) : null;
  const psRows = parsePs(runText(transport.execCapture(["ps", "-e", "-o", "pid=,tty=,stat=,comm="])));
  const idleMap = idleSync(transport, who.map((w) => `/dev/${w.tty}`));

  return assembleSessions(who, psRows, idleMap, selfTty);
}

// Cap each SSH round-trip on the refresh so a host that has gone away can't
// leave a refresh pending forever (the caller's in-flight guard would then
// stop all future refreshes) — it fails fast and the list simply stops
// updating with the last-known rows.
const REFRESH_TIMEOUT_MS = 6000;

export async function listSessionsAsync(transport: Transport): Promise<Session[]> {
  if (MOCK) return mockSessions();
  if (transport.isLocal() && !isLinux()) return [];

  const t = { timeoutMs: REFRESH_TIMEOUT_MS };
  const [whoRes, psRes] = await Promise.all([
    transport.execCaptureAsync(["who"], t),
    transport.execCaptureAsync(["ps", "-e", "-o", "pid=,tty=,stat=,comm="], t),
  ]);
  const who = parseWho(runText(whoRes));
  const psRows = parsePs(runText(psRes));
  // selfTty resolution is local-only and hits SSH_TTY / `tty` (instant), so
  // keeping it synchronous costs nothing on the render path.
  const selfTty = transport.isLocal() ? selfTtyName(transport) : null;
  const idleMap = await idleAsync(transport, who.map((w) => `/dev/${w.tty}`));

  return assembleSessions(who, psRows, idleMap, selfTty);
}

function assembleSessions(
  who: WhoRow[],
  psRows: PsRow[],
  idleMap: Record<string, string>,
  selfTty: string | null,
): Session[] {
  const sessions: Session[] = [];
  for (const row of who) {
    const ttyDev = `/dev/${row.tty}`;
    const { shellPid, foregroundPid, foregroundComm } = ptyOwners(psRows, row.tty);
    sessions.push({
      user: row.user,
      tty: row.tty,
      ttyDev,
      from: row.from,
      loginAt: row.loginAt,
      idle: idleMap[ttyDev] ?? "?",
      shellPid,
      foregroundPid,
      foregroundComm,
      isSelf: selfTty === row.tty,
    });
  }
  return sessions;
}

export function hostLabel(transport: Transport): string {
  if (transport.isLocal()) {
    return `${userInfo().username}@${hostname()}`;
  }
  return transport.label();
}

type WhoRow = { user: string; tty: string; loginAt: string; from: string };

// Return stdout only when the command succeeded (else "" → empty parse).
function runText(r: { status: number; stdout: string }): string {
  return r.status === 0 ? r.stdout : "";
}

function parseWho(stdout: string): WhoRow[] {
  const rows: WhoRow[] = [];
  for (const line of stdout.split("\n")) {
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

type PsRow = { pid: number; tty: string; stat: string; comm: string };

function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: parseInt(m[1]!, 10),
      tty: m[2]!,
      stat: m[3]!,
      comm: m[4]!,
    });
  }
  return rows;
}

// For a given pts (e.g. "pts/0"), find:
//   shellPid       — the session leader (login shell) on that tty
//   foregroundPid  — the process group leader currently in foreground
//   foregroundComm — its comm name (e.g. "vim", "bash", "top")
//
// STAT codes (see ps(1)):
//    's' suffix = session leader
//    '+' suffix = process in the foreground process group of its tty
function ptyOwners(psRows: PsRow[], tty: string): {
  shellPid: number | null;
  foregroundPid: number | null;
  foregroundComm: string | null;
} {
  let leader: PsRow | null = null;
  let foreground: PsRow | null = null;
  for (const row of psRows) {
    if (row.tty !== tty) continue;
    if (row.stat.includes("s") && !leader) leader = row;
    if (row.stat.includes("+")) foreground = row;
  }
  return {
    shellPid: leader?.pid ?? null,
    foregroundPid: foreground?.pid ?? leader?.pid ?? null,
    foregroundComm: foreground?.comm ?? leader?.comm ?? null,
  };
}

function selfTtyName(transport: Transport): string | null {
  const sshTty = process.env.SSH_TTY;
  if (sshTty && sshTty.startsWith("/dev/")) return sshTty.slice(5);
  const r = transport.execCapture(["tty"]);
  if (r.status === 0) {
    const t = r.stdout.trim();
    if (t.startsWith("/dev/")) return t.slice(5);
  }
  return null;
}

// Compute per-tty idle time. For LocalTransport we stat() directly so it
// stays a single VFS hit; for SshTransport we fall back to `stat -c %X`
// in one batched call so we don't pay the SSH round-trip per pts.
function idleSync(transport: Transport, ttyDevs: string[]): Record<string, string> {
  if (transport.isLocal()) return idleLocal(ttyDevs);
  if (ttyDevs.length === 0) return {};
  const r = transport.execCapture(["stat", "-c", "%n %X", ...ttyDevs]);
  return parseStatIdle(r.status === 0 ? r.stdout : null, ttyDevs);
}

async function idleAsync(transport: Transport, ttyDevs: string[]): Promise<Record<string, string>> {
  if (transport.isLocal()) return idleLocal(ttyDevs);
  if (ttyDevs.length === 0) return {};
  const r = await transport.execCaptureAsync(["stat", "-c", "%n %X", ...ttyDevs], { timeoutMs: REFRESH_TIMEOUT_MS });
  return parseStatIdle(r.status === 0 ? r.stdout : null, ttyDevs);
}

function idleLocal(ttyDevs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dev of ttyDevs) {
    try {
      out[dev] = formatIdle(Date.now() - statSync(dev).atimeMs);
    } catch {
      out[dev] = "?";
    }
  }
  return out;
}

// Parse `stat -c "%n %X"` output; a null stdout (command failed) marks every
// requested device as unknown.
function parseStatIdle(stdout: string | null, ttyDevs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (stdout === null) {
    for (const dev of ttyDevs) out[dev] = "?";
    return out;
  }
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [dev, atimeStr] = parts;
    const atime = parseInt(atimeStr!, 10);
    if (!Number.isFinite(atime)) continue;
    out[dev!] = formatIdle(Date.now() - atime * 1000);
  }
  return out;
}

function formatIdle(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return ".";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h${mins % 60}m`;
}

function mockSessions(): Session[] {
  return [
    {
      user: "azureuser", tty: "pts/0", ttyDev: "/dev/pts/0",
      from: "77.119.164.236", loginAt: "2026-05-20 20:35", idle: ".",
      shellPid: 4054, foregroundPid: 4054, foregroundComm: "bash",
      isSelf: false,
    },
    {
      user: "azureuser", tty: "pts/1", ttyDev: "/dev/pts/1",
      from: "(self)", loginAt: "2026-05-20 20:42", idle: ".",
      shellPid: 9999, foregroundPid: 9999, foregroundComm: "bash",
      isSelf: true,
    },
    {
      user: "deploy", tty: "pts/2", ttyDev: "/dev/pts/2",
      from: "10.0.0.7", loginAt: "2026-05-20 20:40", idle: "3m",
      shellPid: 5120, foregroundPid: 5180, foregroundComm: "vim",
      isSelf: false,
    },
  ];
}
